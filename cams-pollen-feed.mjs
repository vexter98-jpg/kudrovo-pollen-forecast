import { execFileSync } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';

const [archive, destination] = process.argv.slice(2);
if (!archive || !destination) throw new Error('Usage: node cams-pollen-feed.mjs forecast.zip output.json');

const buffer = execFileSync('unzip', ['-p', archive, 'ENS_FORECAST.nc']);
if (buffer.toString('hex', 0, 4) !== '43444601') throw new Error('Expected classic CAMS NetCDF');
let offset = 4;
const widths = [0, 1, 1, 2, 4, 4, 8];
const readers = [null, 'readInt8', 'readUInt8', 'readInt16BE', 'readInt32BE', 'readFloatBE', 'readDoubleBE'];

function uint() {
  const result = buffer.readUInt32BE(offset);
  offset += 4;
  return result;
}

function paddedText(length) {
  const result = buffer.toString('ascii', offset, offset + length);
  offset += Math.ceil(length / 4) * 4;
  return result;
}

function list(tag, read) {
  const kind = uint();
  const length = uint();
  if (kind === 0 && length === 0) return [];
  if (kind !== tag) throw new Error('Unexpected NetCDF header');
  return Array.from({length}, read);
}

function attributes() {
  return Object.fromEntries(list(12, () => {
    const name = paddedText(uint());
    const type = uint();
    const length = uint();
    const value = type === 2 ? buffer.toString('ascii', offset, offset + length)
      : buffer[readers[type]](offset);
    offset += Math.ceil(widths[type] * length / 4) * 4;
    return [name, value];
  }));
}

const records = uint();
const dimensions = list(10, () => ({name: paddedText(uint()), size: uint()}));
const metadata = attributes();
const variables = Object.fromEntries(list(11, () => {
  const name = paddedText(uint());
  const shape = Array.from({length: uint()}, () => dimensions[uint()]);
  const attrs = attributes();
  const type = uint();
  const bytes = uint();
  const start = uint();
  return [name, {name, shape, attrs, type, bytes, start}];
}));
const stride = Object.values(variables).filter(v => v.shape[0]?.size === 0)
  .reduce((sum, variable) => sum + variable.bytes, 0);

function sample(variable, indices) {
  let index = 0;
  let position = variable.start;
  for (const {name, size} of variable.shape) {
    const coordinate = indices[name];
    if (!Number.isInteger(coordinate) || coordinate < 0 || coordinate >= (size || records))
      throw new Error('Invalid forecast array index');
    if (size === 0) position += coordinate * stride;
    else index = index * size + coordinate;
  }
  const value = buffer[readers[variable.type]](position + index * widths[variable.type]);
  if (!Number.isFinite(value) || value === variable.attrs._FillValue || value === variable.attrs.missing_value) return null;
  return value * (variable.attrs.scale_factor ?? 1) + (variable.attrs.add_offset ?? 0);
}

function nearest(name, target) {
  const variable = variables[name];
  const values = Array.from({length: variable.shape[0].size}, (_, i) => sample(variable, {[name]: i}));
  let best = 0;
  for (let i = 1; i < values.length; ++i)
    if (Math.abs(values[i] - target) < Math.abs(values[best] - target)) best = i;
  if (Math.abs(values[best] - target) > 0.06) throw new Error('Kudrovo is outside the returned forecast grid');
  return best;
}

const date = /^Europe, (\d{4})(\d{2})(\d{2})\+/.exec(metadata.FORECAST ?? '');
if (!date || variables.time.attrs.units !== 'hours') throw new Error('Unrecognized CAMS forecast time');
const run = new Date(date.slice(1).join('-') + 'T00:00:00Z');
const cell = {latitude: nearest('latitude', 59.908489), longitude: nearest('longitude', 30.513569), level: 0};
const localDate = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Europe/Moscow'});
const series = {birch: 'bpg_conc', grass: 'gpg_conc', mugwort: 'mpg_conc', alder: 'apg_conc'};
const daily = {};
for (const [plant, name] of Object.entries(series)) {
  const variable = variables[name];
  if (variable?.attrs.units !== 'grains/m3') throw new Error('Unexpected CAMS pollen units');
  const days = new Map();
  for (let time = 0; time < records; ++time) {
    const hour = sample(variables.time, {time});
    if (hour === null || hour < 0 || hour >= 96) continue;
    const day = localDate.format(new Date(run.getTime() + 3600000 * hour));
    const value = sample(variable, {...cell, time});
    if (value === null || value < 0 || value >= 1e20) continue;
    const values = days.get(day) ?? new Map();
    values.set(hour, value);
    days.set(day, values);
  }
  daily[plant] = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, values]) => {
    // A CAMS run starts at 03:00 local time. Its first calendar day has 21 forecast hours.
    const required = day === localDate.format(run) ? 21 : 24;
    return {date: day, max: values.size === required ? Math.max(...values.values()) : null};
  });
}

const temporary = destination + '.' + process.pid + '.tmp';
await writeFile(temporary, JSON.stringify({run: run.toISOString(), daily}) + '\n');
await rename(temporary, destination);

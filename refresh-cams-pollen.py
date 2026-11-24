"""Download a daily regional CAMS forecast and refresh the public widget feed."""
import argparse
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

import cdsapi


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    # The full 96-hour run is documented as available by 10:00 UTC.
    run_date = (now - timedelta(days=now.hour < 10)).date().isoformat()
    request = {
        "variable": ["birch_pollen", "grass_pollen", "mugwort_pollen"],
        "model": ["ensemble"],
        "level": ["0"],
        "date": [f"{run_date}/{run_date}"],
        "type": ["forecast"],
        "time": ["00:00"],
        "leadtime_hour": [str(hour) for hour in range(97)],
        "area": [60.1, 30.4, 59.8, 30.7],
        "data_format": "netcdf_zip",
    }
    client = cdsapi.Client(
        url="https://ads.atmosphere.copernicus.eu/api",
        key=os.environ["CAMS_API_TOKEN"],
    )
    converter = Path(__file__).with_name("cams-pollen-feed.mjs")
    with TemporaryDirectory() as directory:
        archive = str(Path(directory) / "forecast.zip")
        client.retrieve("cams-europe-air-quality-forecasts", request, archive)
        subprocess.run(["node", str(converter), archive, str(args.destination)], check=True)


if __name__ == "__main__":
    main()

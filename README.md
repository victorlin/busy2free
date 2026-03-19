# busy2free

Generate an availability feed from "busy" calendar feeds.

## Features

- Handles multiple sources.
- Handles all-day and recurring events.
- Filter on time of day, minimum duration threshold

## Setup

 ```bash
 npm install
 ```

## Configuration

Define settings in a JSON config file:
- `sources`: iCal URLs.
- `minDurationMinutes`: Minimum duration of availability events.
- `searchWindow`: Search window settings.
  - `start`: Start date for the search window. (optional; default: today)
  - `end`: End date for the search window.
  - `weekdays`/`weekends`: Time range for searching.
- Full schema: `config.schema.json`.

## Usage

Fetch input feeds and generate outputs.

```bash
npm run make <config.json>
```

Run tests.

```bash
npm run test
```

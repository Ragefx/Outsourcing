# Outsourcing Tracker

When the factory can't absorb its own order book, work gets placed with partner
plants abroad. Each plant tells us roughly how much it can take, of which kind,
and when — *"Croatia, 200k m², inline, September"*. From there it's a pipeline:
we draft a list, send it, get prices back, and if the prices are fine we open the
orders. This app keeps track of all of that and shows, at a glance, how full each
plant already is.

## Running it

```bash
npm start            # http://localhost:3000
npm run seed         # optional: load a small demo dataset
npm test             # unit tests for the capacity maths and CSV parsing
```

No dependencies and no build step — Node 18+ is all you need. Data lives in a
single JSON file at `data/db.json` (override with `DB_PATH`), written atomically
on every change. Back it up by copying that one file.

## How capacity is counted

Everything is bucketed by **plant × month × order type** (diecut or inline).
Each bucket holds three numbers:

| | Where it comes from |
|---|---|
| **Offered** | What the plant told us it can take — entered on *Offered capacity*. |
| **Reserved** | Batches in the pipeline, at any stage except *rejected*. |
| **Produced** | Actual volume, normally loaded on the *Import* tab. |

A batch we reserved and that has since been produced would otherwise be counted
twice, so **produced volume consumes the reservation in its own bucket first**:

```
openReserved = max(0, reserved − produced)
used         = produced + openReserved
free         = max(0, offered − used)
fill         = used / offered
```

So a plant that offered 200k, has 150k reserved and has already made 110k of it
reads as 150k used (110k produced + 40k still open), 50k free, 75% full — not
260k used. Anything above the offer is drawn as a hatched red overflow segment,
so over-booking is visible rather than clipped.

## The pipeline

A batch moves through the same stages the real process has. All of them reserve
capacity except the last:

`List prepared → Sent to plant → Prices received → Prices OK → Orders opened`,
plus `Rejected / cancelled`.

You can move a batch between stages straight from the dropdown in the *Pipeline*
table, and the **+ In processing** button on any plant card on the overview adds
a batch to that plant without leaving the page — that's the "we have 150k in
processing with this plant" case.

## Importing production data

The *Import* tab takes a CSV, either pasted or chosen from disk. Columns are
matched by name, so most plant exports work untouched:

| Field | Accepted headers | Required |
|---|---|---|
| plant | plant, factory, supplier, country, site | yes |
| sqm | sqm, m2, quantity, qty, area | yes |
| date | date, production date, month, period, week | yes |
| type | type, order type, process | no (set a default instead) |
| reference | reference, ref, order, order no, job | no |

Comma, semicolon and tab delimiters are detected automatically, and the messy
real-world spellings are handled: `200k`, `48 000`, `1.234,50`, `04.09.2026`,
`September 2026`, `Die-Cut`.

Nothing is written until you press **Import** — the first pass is always a
preview that reports how many rows were accepted, which plants are new, and
exactly which lines were rejected and why. Every import is recorded as a batch
under *Import history* and can be undone in one click.

## API

The UI is a thin client over a small JSON API, so the data is scriptable too.

```
GET    /api/overview?period=&orderType=&plantId=   aggregated capacity view
GET    /api/state                                  everything, in one payload
GET    /api/meta                                   order types and pipeline stages

GET  POST         /api/plants          PATCH DELETE /api/plants/:id
GET  POST         /api/offers                DELETE /api/offers/:id
GET  POST         /api/allocations     PATCH DELETE /api/allocations/:id
GET  POST         /api/production            DELETE /api/production/:id
GET  POST         /api/imports               DELETE /api/imports/:id   (undo a batch)
```

`POST /api/imports` takes `{ csv, commit, createMissingPlants, defaultOrderType }`
and returns the same report the UI shows; with `commit: false` it changes nothing.

## Layout

```
server/
  index.js    HTTP server, routing, static files
  api.js      request validation and the REST surface
  domain.js   vocabulary and the capacity maths
  csv.js      tolerant CSV / number / date parsing
  store.js    atomic JSON persistence
  seed.js     demo dataset
public/       the single-page client (no framework)
test/         unit tests
```

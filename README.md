# Outsourcing Tracker

When the factory can't absorb its own order book, work gets placed with partner
plants abroad. Each plant tells us roughly how much it can take, of which kind,
and when — *"Croatia, 200k m², inline, September"*. From there it's a pipeline:
we draft a list, send it, get prices back, and if the prices are fine we open the
orders. This keeps track of all of that and shows, at a glance, how full each
plant already is.

## Where it runs

The board is one page, `web/board.html`, with two homes:

| | How to open it | Where the data lives |
|---|---|---|
| **GitHub Pages** | `https://ragefx.github.io/Outsourcing/` | This browser only, via `localStorage`. Move it with **Export board** / **Restore from file**. |
| **Claude artifact** | the artifact link | A shared store — everyone with access sees the same board, live. |

`docs/index.html` is generated from `web/board.html` — run `npm run build:static`
after editing the board, and commit both.

To publish the Pages site, once: **Settings → Pages → Source: Deploy from a
branch**, pick this branch and the **`/docs`** folder.

## How capacity is counted

Everything is bucketed by **plant × month × order type** (diecut or inline).
Each bucket holds three numbers:

| | Where it comes from |
|---|---|
| **Offered** | What the plant told us it can take — entered on *Offers*. |
| **In processing** | Batches in the pipeline, at any stage except *rejected*. |
| **Ordered** | Work already ordered at the plant, loaded on *Import*. |

A batch we reserved and have since ordered would otherwise be counted twice, so
**ordered volume consumes the reservation in its own bucket first**:

```
openReserved = max(0, reserved − ordered)
used         = ordered + openReserved
free         = max(0, offered − used)
fill         = used / offered
```

So a plant that offered 200k, has 150k in the pipeline and 110k of it already
ordered reads as 150k used, 50k free, 75% full — not 260k.

Two rules follow from how the work actually behaves:

- **Open work carries forward.** Anything still open in a past month moves into
  the current month, because that is when the plant has to run it. The carried
  volume is shown separately rather than folded in silently.
- **Offers expire.** Capacity offered for August cannot be filled in September,
  so a past month's offer drops out instead of inflating what's still free.

Over-booking is only meaningful against an offer: where nothing has been
offered yet, a bucket reads *no offer set* rather than being flagged red.

## The pipeline

A batch moves through the stages the real process has. All of them hold
capacity except the last:

`List prepared → Sent to plant → Prices received → Prices OK → Orders opened`,
plus `Rejected`.

Stages change straight from the dropdown in the *Pipeline* table, and the
**+ In processing** button on any plant adds a batch without leaving the board.

## Importing

**The plants' schedule export (.xlsx).** One sheet per machine, named
`<machine code> <destination>` — `8556 Romunija`. Several machines at the same
destination add up into one plant. Two header rows, data from the third;
**Area** is the quantity, **Due Date** decides the month, and **Type**
(`DIECUT` / `INLINE`) sets the order type. Rows with no type still count towards
the plant's total and read as *No type*.

**A simple CSV.** Columns are matched by name — `plant` (or factory, supplier,
country), `sqm` (m², quantity), `date` (or month, period), optional `type` and
`reference`. Quantities like `200k` or `1.234,50` and dates like `04.09.2026`
or `September 2026` are understood.

Either way the first pass is a preview: nothing is written until you confirm,
and every import can be undone as a batch.

## The Node version

`server/` is a small REST API over an atomically written JSON file, with its own
copy of the capacity maths and a CSV importer. Use it if you'd rather
self-host with a real server than run out of a browser.

```bash
npm start      # http://localhost:3000
npm run seed   # optional demo data
npm test       # unit tests for the capacity maths and CSV parsing
```

It predates the board's schedule importer: it has the CSV import but not the
.xlsx reader, the carry-forward rule or the *Ordered* wording. The two are
independent — the hosted board does not talk to it.

## Layout

```
web/board.html        the board (the page itself)
docs/index.html       generated from it, for GitHub Pages
scripts/              the generator
server/               optional self-hosted REST API + JSON store
test/                 unit tests for the Node version
```

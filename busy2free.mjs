import ical from 'node-ical';
import { createEvents } from 'ics';
import fs from 'fs';
import {
    addDays,
    isBefore,
    isAfter,
    startOfDay,
    endOfDay,
    setHours,
    setMinutes,
    isWeekend,
    areIntervalsOverlapping,
    eachDayOfInterval,
} from 'date-fns';


const config = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf-8'));

// Parse dates and handle optional start
config.searchWindow.start = config.searchWindow.start ? new Date(config.searchWindow.start) : new Date();
config.searchWindow.end = new Date(config.searchWindow.end);

/**
 * Main execution flow.
 */
async function run() {
    try {
        const sourceData = await Promise.all(config.sources.map(async (s) => {
            console.log(`Processing feed: ${s.name}...`);
            const events = await ical.async.fromURL(s.url);
            return {
                name: s.name,
                busy: parseEvents(events, { start: config.searchWindow.start, end: config.searchWindow.end })
            };
        }));

        const results = findAllGaps(
            sourceData,
            config.searchWindow.start,
            config.searchWindow.end,
            config.minDurationMinutes
        );

        // Write outputs
        fs.writeFileSync(config.outputs.json, JSON.stringify(results, null, 2));
        console.log(`✓ Generated ${config.outputs.json}`);

        const icsEvents = results.map(e => ({
            start: [e.start.getFullYear(), e.start.getMonth() + 1, e.start.getDate(), e.start.getHours(), e.start.getMinutes()],
            end: [e.end.getFullYear(), e.end.getMonth() + 1, e.end.getDate(), e.end.getHours(), e.end.getMinutes()],
            title: `Free: ${e.source}`,
        }));

        createEvents(icsEvents, (err, val) => {
            if (err) throw err;
            fs.writeFileSync(config.outputs.ics, val);
            console.log(`✓ Generated ${config.outputs.ics}`);
        });


    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

/**
 * Parses raw iCal events into normalized busy intervals.
 */
export function parseEvents(events, dateRange) {
    const busyIntervals = [];

    const processEvent = (ev) => {
        let start = new Date(ev.start);
        let end = new Date(ev.end);

        // Handle all-day events (date-only objects)
        const isAllDay = !ev.start.getHours && !ev.start.getMinutes || ev.datetype === 'date';
        if (isAllDay) {
            start = startOfDay(start);
            // End date in ICS for all-day is usually the start of the next day
            end = endOfDay(addDays(new Date(ev.end), -1));
        }

        // Filter to range
        if (isAfter(end, dateRange.start) && isBefore(start, dateRange.end)) {
            busyIntervals.push({ start, end });
        }
    };

    for (const k in events) {
        if (Object.prototype.hasOwnProperty.call(events, k)) {
            const ev = events[k];
            if (ev.type === 'VEVENT') {
                processEvent(ev);
                // Handle recurring events
                if (ev.recurrences) {
                    for (const date in ev.recurrences) {
                        processEvent(ev.recurrences[date]);
                    }
                }
            }
        }
    }
    return busyIntervals;
}

/**
 * Combine event gaps from all sources.
 */
export function findAllGaps(sourceData, startRange, endRange, minMinutes) {
    const allGapEvents = [];
    for (const source of sourceData) {
        allGapEvents.push(...findGaps(source, startRange, endRange, minMinutes));
    }
    return allGapEvents.sort((a, b) => a.start - b.start);
}

/**
 * Find event gaps from a source.
 */
export function findGaps(source, startRange, endRange, minMinutes) {
    const gaps = [];
    const days = eachDayOfInterval({ start: startRange, end: endRange });

    for (const day of days) {
        const window = getSearchWindow(day);

        // Snap start to next slot boundary
        let current = isAfter(window.start, startRange) ? window.start : startRange;
        const gridMs = config.slotStepMinutes * 60 * 1000;
        if (current.getTime() % gridMs !== 0) {
            current = new Date(Math.ceil(current.getTime() / gridMs) * gridMs);
        }

        while (isBefore(current, window.end)) {
            const slotEnd = new Date(current.getTime() + config.slotStepMinutes * 60000);
            if (isAfter(slotEnd, window.end)) break;

            const isBusy = source.busy.some(interval =>
                areIntervalsOverlapping({ start: current, end: slotEnd }, interval)
            );

            if (!isBusy) {
                gaps.push({ start: new Date(current), end: slotEnd, source: source.name });
            }
            current = slotEnd;
        }
    }

    // Merge contiguous slots
    const merged = [];
    if (gaps.length > 0) {
        let currentGroup = { ...gaps[0] };

        for (let i = 1; i < gaps.length; i++) {
            const next = gaps[i];
            if (currentGroup.end.getTime() === next.start.getTime()) {
                currentGroup.end = next.end;
            } else {
                merged.push(currentGroup);
                currentGroup = { ...next };
            }
        }
        merged.push(currentGroup);
    }

    // Filter by minimum duration
    return merged.filter(gap => {
        const dur = Math.round((gap.end - gap.start) / 60000);
        return dur >= minMinutes;
    });
}

/**
 * Returns the search window for a given day.
 */
function getSearchWindow(day) {
    const { weekdays, weekends } = config.searchWindow;
    const windowConfig = isWeekend(day) ? weekends : weekdays;

    const start = setMinutes(setHours(startOfDay(day), windowConfig.startHour), 0);
    const end = setMinutes(setHours(startOfDay(day), windowConfig.endHour), 0);
    return { start, end };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
}

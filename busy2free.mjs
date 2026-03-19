import ical from 'node-ical';
import { createEvents } from 'ics';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { fromZonedTime } from 'date-fns-tz';
import {
    addDays,
    isBefore,
    isAfter,
    startOfDay,
    endOfDay,
    areIntervalsOverlapping,
} from 'date-fns';

function getTimeZoneParts(date, timeZone) {
    const dtf = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
    const parts = {};
    for (const part of dtf.formatToParts(date)) {
        if (part.type !== 'literal') {
            parts[part.type] = part.value;
        }
    }
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        second: Number(parts.second),
    };
}

function formatOffsetMinutes(offsetMinutes) {
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMinutes);
    const hours = String(Math.floor(abs / 60)).padStart(2, '0');
    const minutes = String(abs % 60).padStart(2, '0');
    return `${sign}${hours}:${minutes}`;
}

function formatInTimeZone(date, timeZone) {
    const parts = getTimeZoneParts(date, timeZone);
    const utcMs = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second
    );
    const offsetMinutes = Math.round((utcMs - date.getTime()) / 60000);
    const yyyy = String(parts.year).padStart(4, '0');
    const mm = String(parts.month).padStart(2, '0');
    const dd = String(parts.day).padStart(2, '0');
    const hh = String(parts.hour).padStart(2, '0');
    const min = String(parts.minute).padStart(2, '0');
    const ss = String(parts.second).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}${formatOffsetMinutes(offsetMinutes)}`;
}

function toUtcArray(date) {
    return [
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDate(),
        date.getUTCHours(),
        date.getUTCMinutes(),
    ];
}

function pad(number) {
    return String(number).padStart(2, '0');
}

function zonedPartsToIsoLocal(parts, hour = 0, minute = 0, second = 0) {
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

function addDaysToParts(parts, days) {
    const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
    return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
    };
}

function toZonedInstant(parts, hour, minute, timeZone) {
    if (hour === 24) {
        const nextDay = addDaysToParts(parts, 1);
        return fromZonedTime(zonedPartsToIsoLocal(nextDay), timeZone);
    }

    return fromZonedTime(zonedPartsToIsoLocal(parts, hour, minute), timeZone);
}

function eachDayInTimeZone(start, end, timeZone) {
    const startParts = getTimeZoneParts(start, timeZone);
    const endParts = getTimeZoneParts(end, timeZone);
    const days = [];
    let cursor = {
        year: startParts.year,
        month: startParts.month,
        day: startParts.day,
    };
    const endKey = `${endParts.year}-${pad(endParts.month)}-${pad(endParts.day)}`;

    while (true) {
        days.push(cursor);
        const cursorKey = `${cursor.year}-${pad(cursor.month)}-${pad(cursor.day)}`;
        if (cursorKey === endKey) {
            return days;
        }
        cursor = addDaysToParts(cursor, 1);
    }
}

function loadConfig(configUrl) {
    const config = JSON.parse(fs.readFileSync(configUrl, 'utf-8'));

    // Parse dates and handle optional start
    config.searchWindow.start = config.searchWindow.start ? new Date(config.searchWindow.start) : new Date();
    config.searchWindow.end = new Date(config.searchWindow.end);

    return config;
}

function resolveConfigUrl(configPath) {
    if (!configPath) {
        throw new Error('Usage: node busy2free.mjs <config-path>');
    }

    return pathToFileURL(path.resolve(process.cwd(), configPath));
}

/**
 * Merges source-specific search window with global config.
 */
function getEffectiveSearchWindow(source, defaultSearchWindow) {
    const override = source.searchWindow || {};

    return {
        start: override.start ? new Date(override.start) : defaultSearchWindow.start,
        end: override.end ? new Date(override.end) : defaultSearchWindow.end,
        weekdays: {
            startHour: override.weekdays?.startHour ?? defaultSearchWindow.weekdays.startHour,
            endHour: override.weekdays?.endHour ?? defaultSearchWindow.weekdays.endHour,
        },
        weekends: {
            startHour: override.weekends?.startHour ?? defaultSearchWindow.weekends.startHour,
            endHour: override.weekends?.endHour ?? defaultSearchWindow.weekends.endHour,
        }
    };
}

/**
 * Main execution flow.
 */
async function run(configPath = process.argv[2]) {
    try {
        const config = loadConfig(resolveConfigUrl(configPath));

        const sourceData = await Promise.all(config.sources.map(async (s) => {
            console.log(`Processing feed: ${s.name}...`);
            const events = await ical.async.fromURL(s.url);
            const effectiveWindow = getEffectiveSearchWindow(s, config.searchWindow);
            return {
                name: s.name,
                busy: parseEvents(events, { start: effectiveWindow.start, end: effectiveWindow.end }),
                searchWindow: effectiveWindow,
                minDurationMinutes: s.minDurationMinutes
            };
        }));

        const results = findAllGaps(
            sourceData,
            config.searchWindow.start,
            config.searchWindow.end,
            config.minDurationMinutes,
            config.searchWindow,
            config.slotStepMinutes,
            config.timeZone
        );

        // Write outputs
        const jsonResults = results.map(result => ({
            start: formatInTimeZone(result.start, config.timeZone),
            end: formatInTimeZone(result.end, config.timeZone),
            source: result.source,
        }));
        fs.writeFileSync(config.outputs.json, JSON.stringify(jsonResults, null, 2));
        console.log(`✓ Generated ${config.outputs.json}`);

        const icsEvents = results.map(e => ({
            start: toUtcArray(e.start),
            end: toUtcArray(e.end),
            startInputType: 'utc',
            endInputType: 'utc',
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
export function findAllGaps(sourceData, startRange, endRange, globalMinMinutes, defaultSearchWindow, slotStepMinutes, timeZone) {
    const allGapEvents = [];
    for (const source of sourceData) {
        const sStart = source.searchWindow?.start || startRange;
        const sEnd = source.searchWindow?.end || endRange;
        const sMinMinutes = source.minDurationMinutes ?? globalMinMinutes;
        allGapEvents.push(...findGaps(source, sStart, sEnd, sMinMinutes, defaultSearchWindow, slotStepMinutes, timeZone));
    }
    return allGapEvents.sort((a, b) => {
        const startDiff = a.start - b.start;
        if (startDiff !== 0) return startDiff;
        return String(a.source).localeCompare(String(b.source));
    });
}

/**
 * Find event gaps from a source.
 */
export function findGaps(source, startRange, endRange, minMinutes, defaultSearchWindow, slotStepMinutes, timeZone = 'UTC') {
    const gaps = [];
    const days = eachDayInTimeZone(startRange, endRange, timeZone);

    for (const day of days) {
        const window = getSearchWindow(day, source.searchWindow, defaultSearchWindow, timeZone);

        // Snap start to next slot boundary
        let current = isAfter(window.start, startRange) ? window.start : startRange;
        const gridMs = slotStepMinutes * 60 * 1000;
        if (current.getTime() % gridMs !== 0) {
            current = new Date(Math.ceil(current.getTime() / gridMs) * gridMs);
        }

        while (isBefore(current, window.end)) {
            const slotEnd = new Date(current.getTime() + slotStepMinutes * 60000);
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
function getSearchWindow(dayParts, sourceSearchWindow, defaultSearchWindow, timeZone) {
    const weekday = new Date(Date.UTC(dayParts.year, dayParts.month - 1, dayParts.day)).getUTCDay();
    const windowConfig = weekday === 0 || weekday === 6
        ? {
            startHour: sourceSearchWindow?.weekends?.startHour ?? defaultSearchWindow.weekends.startHour,
            endHour: sourceSearchWindow?.weekends?.endHour ?? defaultSearchWindow.weekends.endHour,
        }
        : {
            startHour: sourceSearchWindow?.weekdays?.startHour ?? defaultSearchWindow.weekdays.startHour,
            endHour: sourceSearchWindow?.weekdays?.endHour ?? defaultSearchWindow.weekdays.endHour,
        };

    const start = toZonedInstant(dayParts, windowConfig.startHour, 0, timeZone);
    const end = toZonedInstant(dayParts, windowConfig.endHour, 0, timeZone);
    return { start, end };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
}

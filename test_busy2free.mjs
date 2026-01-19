import { findGaps, findAllGaps, parseEvents } from './busy2free.mjs';
import { startOfDay, addDays, setHours, format, endOfDay } from 'date-fns';

const today = startOfDay(new Date());
const monday = addDays(today, (1 - today.getDay() + 7) % 7);
const tuesday = addDays(monday, 1);

const Range = { start: monday, end: addDays(monday, 7) };

function assert(condition, message) {
    if (!condition) {
        console.error(`❌ FAILED: ${message}`);
        process.exit(1);
    }
}

function testRecurrence() {
    console.log('Testing Recurrence Grouping...');
    const mockData = {
        'uid-1': {
            type: 'VEVENT',
            start: monday,
            end: setHours(monday, 1),
            recurrences: {
                '2026-01-20': { start: tuesday, end: setHours(tuesday, 1) }
            }
        }
    };
    const busy = parseEvents(mockData, Range);
    assert(busy.length === 2, 'Should parse 2 intervals from grouped recurrences');
    console.log('✅ Recurrence grouping passed');
}

function testDurationFilter() {
    console.log('Testing Minimum Duration (90 min)...');
    const mockSourceData = [{
        name: 'Shorty',
        busy: [
            { start: setHours(monday, 18), end: setHours(monday, 19) }, // Busy 6-7pm -> Free 7-12pm (5h)
            { start: setHours(monday, 22), end: setHours(monday, 23) }  // Busy 10-11pm -> Free 7-10 (3h) AND 11-12 (1h)
        ]
    }];

    const results = findAllGaps(mockSourceData, monday, endOfDay(monday), 90);
    assert(results.length === 1, `Expected 1 gap (7-10pm), got ${results.length}`);
    assert(results[0].start.getHours() === 19 && results[0].end.getHours() === 22, 'Remaining gap should be 7pm-10pm');
    console.log('✅ Duration filter passed');
}

function testOverlaps() {
    console.log('Testing Independent Source Overlaps...');
    const mockSourceData = [
        { name: 'SourceA', busy: [] },
        { name: 'SourceB', busy: [] }
    ];

    const results = findAllGaps(mockSourceData, monday, endOfDay(monday), 0);
    const monday1800 = results.filter(s => format(s.start, 'HH:mm') === '18:00');
    assert(monday1800.length === 2, `Expected 2 overlapping gap events, got ${monday1800.length}`);
    console.log('✅ Independent overlaps passed');
}

function testSingleSource() {
    console.log('Testing Single Source findGaps...');
    const mockSource = {
        name: 'Single',
        busy: [
            { start: setHours(monday, 10), end: setHours(monday, 11) }
        ]
    };
    const results = findGaps(mockSource, monday, endOfDay(monday), 60);
    assert(results.length > 0, 'Should find gaps for single source');
    assert(results.some(r => r.source === 'Single'), 'Gap should have source name');
    console.log('✅ Single source passed');
}

console.log('--- busy2free Test Suite ---\n');
testRecurrence();
testDurationFilter();
testOverlaps();
testSingleSource();
console.log('\n✨ ALL STABLE ARCHITECTURE TESTS PASSED');

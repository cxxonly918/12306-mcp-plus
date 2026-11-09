import test from 'node:test';
import assert from 'node:assert/strict';
import {
    addMinutes,
    durationMinutes,
    extractLishi,
    formatDateTime,
    parseDateWithTime,
    parseWaitMinutes,
} from '../build/date-utils.js';

test('parseDateWithTime combines date and time', () => {
    const d = parseDateWithTime('2026-10-06', '19:50');
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 9); // 10 月（月份从 0 开始）
    assert.equal(d.getDate(), 6);
    assert.equal(d.getHours(), 19);
    assert.equal(d.getMinutes(), 50);
});

test('parseDateWithTime supports leap day', () => {
    const d = parseDateWithTime('2028-02-29', '00:05');
    assert.equal(d.getMonth(), 1);
    assert.equal(d.getDate(), 29);
});

test('durationMinutes parses hh:mm', () => {
    assert.equal(durationMinutes('03:40'), 220);
    assert.equal(durationMinutes('00:05'), 5);
    assert.equal(durationMinutes('01:07'), 67);
});

test('addMinutes crosses midnight, month and year boundaries', () => {
    const d = addMinutes(new Date(2026, 9, 6, 23, 30), 40);
    assert.equal(d.getDate(), 7);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 10);

    const e = addMinutes(new Date(2026, 11, 31, 23, 50), 40);
    assert.equal(e.getFullYear(), 2027);
    assert.equal(e.getMonth(), 0);
    assert.equal(e.getDate(), 1);
    assert.equal(e.getHours(), 0);
    assert.equal(e.getMinutes(), 30);
});

test('parseWaitMinutes handles common formats', () => {
    assert.equal(parseWaitMinutes('40分钟'), 40);
    assert.equal(parseWaitMinutes('1小时5分钟'), 65);
    assert.equal(parseWaitMinutes('2小时0分钟'), 120);
    assert.equal(parseWaitMinutes('', 10), 10);
});

test('extractLishi pads minutes to two digits (issue #72 "05:5")', () => {
    assert.equal(extractLishi('5小时5分钟'), '05:05');
    assert.equal(extractLishi('40分钟'), '00:40');
    assert.equal(extractLishi('1小时59分钟'), '01:59');
});

test('issue #72 scenario: G65 -> G4791 cross-midnight transfer', () => {
    // 2026-10-06 19:50 北京南发车 G65，历时 03:40，23:30 到南京南；
    // 等待 40 分钟后于 00:10 乘 G4791，历时 01:07，01:17 到上海虹桥。
    // 第二段出发/到达日期必须是 10 月 7 日，而不是始发日期 10 月 6 日。
    const firstDeparture = parseDateWithTime('2026-10-06', '19:50');
    const firstArrival = addMinutes(
        firstDeparture,
        durationMinutes('03:40')
    );
    assert.equal(formatDateTime(firstArrival), '2026-10-06 23:30');

    const secondDeparture = addMinutes(
        firstArrival,
        parseWaitMinutes('40分钟')
    );
    assert.equal(formatDateTime(secondDeparture), '2026-10-07 00:10');

    const secondArrival = addMinutes(
        secondDeparture,
        durationMinutes('01:07')
    );
    assert.equal(formatDateTime(secondArrival), '2026-10-07 01:17');

    // 总历时 05:27 = 327 分钟，与 12306 返回的 all_lishi_minutes=327 一致
    const totalMinutes =
        (secondArrival.getTime() - firstDeparture.getTime()) / 60000;
    assert.equal(totalMinutes, 327);
});

test('issue #72 scenario: G805 -> G1939 same-day transfer', () => {
    // 10月6日 16:30 北京南出发，南京南等 44 分钟，当日 23:57 抵达，总历时 07:27。
    const firstDeparture = parseDateWithTime('2026-10-06', '16:30');
    const firstArrival = addMinutes(
        firstDeparture,
        durationMinutes('05:27')
    );
    const secondDeparture = addMinutes(firstArrival, 44);
    const secondArrival = addMinutes(
        secondDeparture,
        durationMinutes('01:16')
    );
    assert.equal(formatDateTime(secondDeparture), '2026-10-06 22:41');
    assert.equal(formatDateTime(secondArrival), '2026-10-06 23:57');

    const totalMinutes =
        (secondArrival.getTime() - firstDeparture.getTime()) / 60000;
    assert.equal(totalMinutes, 447); // 07:27
});

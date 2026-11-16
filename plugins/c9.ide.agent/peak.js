/**
 * DeepSeek's peak hours: whether a moment is in them, and when that changes.
 *
 * A schedule has peak windows in UTC ([start, end) in minutes of a UTC day),
 * the UTC weekdays they apply on, and dates without any peak hours (Chinese
 * public holidays). Those dates are dates in China time (UTC+8, no daylight
 * saving), where holidays are decided. A window across midnight
 * ("22:00-02:00") is two windows, each on its own day.
 *
 * Times are milliseconds since the epoch; nothing here reads the clock.
 */
define(function(require, exports, module) {
    "use strict";

    var MINUTE = 60000;
    var DAY = 1440 * MINUTE;
    var CHINA_OFFSET = 8 * 60 * MINUTE;
    var DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var MAX_WINDOWS = 24;
    var MAX_DATES = 3660;       // dates without peak hours, ranges included
    var LOOKAHEAD = 60;         // days searched for the next change

    // "01:00-04:00, 06:00-10:00" -> [{ start: 60, end: 240 }, { start: 360, end: 600 }]
    function parseHours(text) {
        var windows = [];
        var parts = String(text || "").split(/[,;]/).map(trim).filter(Boolean);
        for (var i = 0; i < parts.length; i++) {
            var m = /^(\d{1,2}):(\d{2})\s*(?:-|–|to)\s*(\d{1,2}):(\d{2})$/i.exec(parts[i]);
            if (!m) throw new Error("“" + parts[i] + "” is not a time range like 01:00-04:00");
            var start = minutes(m[1], m[2]), end = minutes(m[3], m[4]);
            if (start == null || end == null || start >= 1440 && end >= 1440)
                throw new Error("“" + parts[i] + "”: times go from 00:00 to 24:00");
            if (start == end) throw new Error("“" + parts[i] + "” is empty");
            if (start < end) windows.push({ start: start, end: end });
            else {
                // across midnight
                windows.push({ start: start, end: 1440 });
                if (end > 0) windows.push({ start: 0, end: end });
            }
        }
        if (windows.length > MAX_WINDOWS) throw new Error("At most " + MAX_WINDOWS + " time ranges");
        windows.sort(function(a, b) { return a.start - b.start; });
        return windows;
    }

    function minutes(h, m) {
        h = +h;
        m = +m;
        if (m > 59 || h > 24 || h == 24 && m) return null;
        return h * 60 + m;
    }

    // "Mon-Fri", "Mon, Wed, Fri", "Sat-Sun", "Fri-Mon" -> { 1: true, ... }
    function parseDays(text) {
        var days = {};
        var parts = String(text || "").split(/[,;]/).map(trim).filter(Boolean);
        parts.forEach(function(part) {
            var m = /^([a-z]{3})[a-z]*(?:\s*(?:-|–|to)\s*([a-z]{3})[a-z]*)?$/i.exec(part);
            var from = m && dayIndex(m[1]), to = m && (m[2] ? dayIndex(m[2]) : from);
            if (from == null || to == null)
                throw new Error("“" + part + "” is not a day or a range of days like Mon-Fri");
            for (var d = from; ; d = (d + 1) % 7) {
                days[d] = true;
                if (d == to) break;
            }
        });
        return days;
    }

    function dayIndex(name) {
        var i = DAY_NAMES.map(function(d) { return d.toLowerCase(); }).indexOf(String(name).toLowerCase());
        return i == -1 ? null : i;
    }

    // "2026-10-01..2026-10-07, 2027-01-01" -> { "2026-10-01": true, ... }
    function parseDates(text) {
        var dates = {};
        var count = 0;
        var parts = String(text || "").split(/[,;\s]+/).map(trim).filter(Boolean);
        parts.forEach(function(part) {
            var m = /^(\d{4}-\d{2}-\d{2})(?:\.\.(\d{4}-\d{2}-\d{2}))?$/.exec(part);
            var from = m && dayNumber(m[1]), to = m && (m[2] ? dayNumber(m[2]) : from);
            if (from == null || to == null)
                throw new Error("“" + part + "” is not a date (2026-10-01) or a range (2026-10-01..2026-10-07)");
            if (to < from) throw new Error("“" + part + "” ends before it starts");
            for (var d = from; d <= to; d++) {
                if (++count > MAX_DATES) throw new Error("Too many dates (at most " + MAX_DATES + ")");
                dates[dateString(d * DAY)] = true;
            }
        });
        return dates;
    }

    // "2026-10-01" -> days since the epoch, or null for an invalid date
    function dayNumber(text) {
        var t = Date.parse(text + "T00:00:00Z");
        if (isNaN(t) || dateString(t) != text) return null;
        return Math.round(t / DAY);
    }

    // the UTC date of t as "YYYY-MM-DD"
    function dateString(t) {
        return new Date(t).toISOString().slice(0, 10);
    }

    function trim(s) {
        return String(s).trim();
    }

    // opts: { hours, days, noPeak } (texts). Returns { schedule, errors }:
    // a field that does not parse is reported in errors and taken from
    // fallback (the same fields, already valid) when given.
    function parse(opts, fallback) {
        var errors = {};
        var schedule = {};
        [["hours", "windows", parseHours], ["days", "days", parseDays], ["noPeak", "noPeak", parseDates]].forEach(function(f) {
            try {
                schedule[f[1]] = f[2](opts[f[0]]);
            } catch (e) {
                errors[f[0]] = e.message;
                schedule[f[1]] = fallback ? f[2](fallback[f[0]]) : f[1] == "windows" ? [] : {};
            }
        });
        return { schedule: schedule, errors: errors };
    }

    // the date in China (UTC+8) at t, as "YYYY-MM-DD"
    function chinaDate(t) {
        return dateString(t + CHINA_OFFSET);
    }

    function isPeak(schedule, t) {
        var d = new Date(t);
        if (!schedule.days[d.getUTCDay()]) return false;
        if (schedule.noPeak[chinaDate(t)]) return false;
        var m = d.getUTCHours() * 60 + d.getUTCMinutes();
        return schedule.windows.some(function(w) { return m >= w.start && m < w.end; });
    }

    // The first moment after t when isPeak changes, or null if it does not
    // in the next LOOKAHEAD days. It can only change at a window's start or
    // end, at UTC midnight (another weekday) or at midnight in China
    // (another date).
    function nextChange(schedule, t) {
        var now = isPeak(schedule, t);
        var day0 = Math.floor(t / DAY) * DAY;
        for (var k = 0; k <= LOOKAHEAD; k++) {
            var day = day0 + k * DAY;
            var times = [day, day + DAY - CHINA_OFFSET];
            schedule.windows.forEach(function(w) {
                times.push(day + w.start * MINUTE, day + w.end * MINUTE);
            });
            times.sort(function(a, b) { return a - b; });
            for (var i = 0; i < times.length; i++) {
                if (times[i] > t && isPeak(schedule, times[i]) != now) return times[i];
            }
        }
        return null;
    }

    // "01:00–04:00, 06:00–10:00" (UTC), joining a window across midnight
    function formatWindows(windows) {
        var list = windows.map(function(w) { return { start: w.start, end: w.end }; });
        var last = list[list.length - 1], first = list[0];
        if (list.length > 1 && last.end == 1440 && first.start == 0) {
            last.end = first.end;
            list.shift();
        }
        return list.map(function(w) { return hhmm(w.start) + "–" + hhmm(w.end); }).join(", ");
    }

    function hhmm(m) {
        m = m % 1440;
        var h = Math.floor(m / 60);
        return (h < 10 ? "0" : "") + h + ":" + (m % 60 < 10 ? "0" : "") + (m % 60);
    }

    // "Mon–Fri", "Mon, Wed, Fri", "every day", "no day"
    function formatDays(days) {
        var list = [];
        for (var d = 1; d <= 7; d++) if (days[d % 7]) list.push(d % 7);
        if (list.length == 7) return "every day";
        if (!list.length) return "no day";
        // consecutive from Monday on (Sunday last)
        var order = list.map(function(d) { return (d + 6) % 7; });
        var runs = [];
        order.forEach(function(d) {
            var run = runs[runs.length - 1];
            if (run && d == run[1] + 1) run[1] = d;
            else runs.push([d, d]);
        });
        return runs.map(function(r) {
            var a = DAY_NAMES[(r[0] + 1) % 7], b = DAY_NAMES[(r[1] + 1) % 7];
            return r[0] == r[1] ? a : r[1] == r[0] + 1 ? a + ", " + b : a + "–" + b;
        }).join(", ");
    }

    exports.parse = parse;
    exports.parseHours = parseHours;
    exports.parseDays = parseDays;
    exports.parseDates = parseDates;
    exports.isPeak = isPeak;
    exports.nextChange = nextChange;
    exports.chinaDate = chinaDate;
    exports.formatWindows = formatWindows;
    exports.formatDays = formatDays;
    exports.MINUTE = MINUTE;
    exports.DAY = DAY;
});

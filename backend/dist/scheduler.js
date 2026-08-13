export const BUENOS_AIRES_TIMEZONE = 'America/Argentina/Buenos_Aires';
export const DAILY_MIN_WARMUP_SECONDS = 39 * 60;
export const DAILY_MAX_WARMUP_SECONDS = 48 * 60;
export const DEFAULT_FIXED_WARMUP_SECONDS = 40 * 60;
export const MIN_WARMUP_SESSIONS = 2;
export const MAX_WARMUP_SESSIONS = 3;
export const OVERDUE_AFTER_MS = 2 * 60 * 60 * 1000;
export const EXPIRES_AFTER_MS = 36 * 60 * 60 * 1000;
function boundedRandom(random) {
    const value = Number(random());
    if (!Number.isFinite(value))
        return 0.5;
    return Math.min(0.999999, Math.max(0, value));
}
function randomInt(min, max, random) {
    if (max <= min)
        return min;
    return min + Math.floor(boundedRandom(random) * (max - min + 1));
}
/**
 * Generates the daily target in whole minutes. The skew keeps the normal
 * result close to forty minutes while still allowing the configured 39–48
 * minute range. This is scheduling variability, not a platform-evasion rule.
 */
export function chooseDailyTargetSeconds(mode = 'random', random = Math.random, fixedSeconds = DEFAULT_FIXED_WARMUP_SECONDS) {
    if (mode === 'fixed') {
        return Math.min(DAILY_MAX_WARMUP_SECONDS, Math.max(DAILY_MIN_WARMUP_SECONDS, Math.round(fixedSeconds / 60) * 60));
    }
    const skewed = Math.pow(boundedRandom(random), 2.2);
    const targetMinutes = 39 + Math.floor(skewed * (48 - 39 + 1));
    return targetMinutes * 60;
}
export function chooseSessionCount(random = Math.random, fixedCount) {
    if (fixedCount === 2 || fixedCount === 3)
        return fixedCount;
    return boundedRandom(random) < 0.5 ? 2 : 3;
}
/**
 * Splits a daily target into two or three practical sessions while preserving
 * the exact total. The returned values are whole minutes, so the mobile app
 * can continue receiving its existing duration_minutes parameter.
 */
export function splitWarmupDurationSeconds(totalSeconds, sessionCount, random = Math.random) {
    const totalMinutes = Math.max(1, Math.round(totalSeconds / 60));
    if (sessionCount === 2) {
        const firstMin = Math.ceil(totalMinutes * 0.4);
        const firstMax = Math.floor(totalMinutes * 0.6);
        const first = randomInt(firstMin, Math.max(firstMin, firstMax), random);
        return [first * 60, (totalMinutes - first) * 60];
    }
    const firstMin = Math.max(1, Math.floor(totalMinutes * 0.25));
    const firstMax = Math.max(firstMin, Math.floor(totalMinutes * 0.42));
    const first = randomInt(firstMin, firstMax, random);
    const remaining = totalMinutes - first;
    const secondMin = Math.max(1, Math.floor(remaining * 0.4));
    const secondMax = Math.max(secondMin, Math.floor(remaining * 0.6));
    const second = randomInt(secondMin, secondMax, random);
    return [first * 60, second * 60, (remaining - second) * 60];
}
export function addHoursIso(value, hours) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) {
        throw new Error('Invalid ISO date: ' + value);
    }
    return new Date(timestamp + hours * 60 * 60 * 1000).toISOString();
}
export function overdueAtIso(scheduledFor) {
    return addHoursIso(scheduledFor, 2);
}
export function expiresAtIso(scheduledFor) {
    return addHoursIso(scheduledFor, 36);
}
export function localDateTimeToIso(dateKey, timeValue, timezone = BUENOS_AIRES_TIMEZONE) {
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
    const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeValue);
    if (!dateMatch || !timeMatch) {
        throw new Error('Invalid local date/time');
    }
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
    const localizedParts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(new Date(naiveUtc));
    const partValue = (type) => Number(localizedParts.find((part) => part.type === type)?.value || 0);
    const localizedAsUtc = Date.UTC(partValue('year'), partValue('month') - 1, partValue('day'), partValue('hour'), partValue('minute'), partValue('second'));
    const offset = localizedAsUtc - naiveUtc;
    return new Date(naiveUtc - offset).toISOString();
}
export function isTaskDue(scheduledFor, now = new Date()) {
    if (!scheduledFor)
        return true;
    const timestamp = Date.parse(String(scheduledFor));
    return Number.isFinite(timestamp) && timestamp <= now.getTime();
}
export function isTaskOverdue(scheduledFor, now = new Date()) {
    if (!scheduledFor)
        return false;
    const timestamp = Date.parse(String(scheduledFor));
    return Number.isFinite(timestamp)
        && now.getTime() >= timestamp + OVERDUE_AFTER_MS;
}
export function isTaskExpired(scheduledFor, now = new Date()) {
    if (!scheduledFor)
        return false;
    const timestamp = Date.parse(String(scheduledFor));
    return Number.isFinite(timestamp)
        && now.getTime() >= timestamp + EXPIRES_AFTER_MS;
}

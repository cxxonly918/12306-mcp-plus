import { parse, format } from 'date-fns';

/**
 * 把 "yyyy-MM-dd" 与 "HH:mm" 合并成本地时区的 Date。
 */
export function parseDateWithTime(dateStr: string, timeStr: string): Date {
    const d = parse(dateStr, 'yyyy-MM-dd', new Date());
    const [hours, minutes] = timeStr.split(':').map((x) => parseInt(x, 10));
    d.setHours(hours, minutes, 0, 0);
    return d;
}

/**
 * "HH:mm" 形式的历时 -> 分钟数。
 */
export function durationMinutes(lishi: string): number {
    const [hours, minutes] = lishi.split(':').map((x) => parseInt(x, 10));
    return (hours || 0) * 60 + (minutes || 0);
}

/**
 * 在日期上增加分钟数，自动处理跨天/跨月/跨年。
 */
export function addMinutes(date: Date, minutes: number): Date {
    return new Date(date.getTime() + minutes * 60000);
}

/**
 * 解析 "40分钟" / "1小时5分钟" 形式的等待时间，返回分钟数。
 * 解析失败时返回 fallbackMinutes（默认 0）。
 */
export function parseWaitMinutes(
    waitTime: string,
    fallbackMinutes: number = 0
): number {
    const match = waitTime.match(/(?:(\d+)小时)?(\d+?)分钟/);
    if (!match) {
        return fallbackMinutes;
    }
    const hours = match[1] ? parseInt(match[1], 10) : 0;
    const minutes = match[2] ? parseInt(match[2], 10) : 0;
    return hours * 60 + minutes;
}

/**
 * 把 Date 格式化为 "yyyy-MM-dd HH:mm"，用于日志与校验。
 */
export function formatDateTime(date: Date): string {
    return format(date, 'yyyy-MM-dd HH:mm');
}

/**
 * 解析 "5小时5分钟" / "40分钟" 形式的历时，输出补零的 "hh:mm"。
 * 修复原实现中分钟不补零的问题（"05:5"，见 issue #72）。
 */
export function extractLishi(all_lishi: string): string {
    const match = all_lishi.match(/(?:(\d+)小时)?(\d+?)分钟/);
    if (!match) {
        throw new Error('extractLishi失败，没有匹配到关键词');
    }
    if (!match[1]) {
        return `00:${match[2].padStart(2, '0')}`;
    }
    return `${match[1].padStart(2, '0')}:${match[2].padStart(2, '0')}`;
}

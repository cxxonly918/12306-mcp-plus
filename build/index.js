#!/usr/bin/env node
// Data一般用于表示从服务器上请求到的数据，Info一般表示解析并筛选过的要传输给大模型的数据。变量使用驼峰命名，常量使用全大写下划线命名。
import { program } from 'commander';
import { startSseAndStreamableHttpMcpServer } from 'mcp-http-server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import axios from 'axios';
import { z } from 'zod';
import { format, parse } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { addMinutes, durationMinutes, extractLishi, formatDateTime, parseDateWithTime, parseWaitMinutes, } from './date-utils.js';
import { StationDataKeys, TicketDataKeys, } from './types.js';
const VERSION = '0.4.0';
const API_BASE = 'https://kyfw.12306.cn';
const SEARCH_API_BASE = 'https://search.12306.cn';
const WEB_URL = 'https://www.12306.cn/index/';
const LCQUERY_INIT_URL = 'https://kyfw.12306.cn/otn/lcQuery/init';
const TICKETS_QUERY_INIT_URL = 'https://kyfw.12306.cn/otn/leftTicket/init';
// 启动时不再阻塞式请求 12306 获取接口路径，改为懒加载（见 issue #67/#68）
let LCQUERY_PATH = '';
let TICKETS_QUERY_PATH = '';
const MISSING_STATIONS = [
    {
        station_id: '@cdd',
        station_name: '成  都东',
        station_code: 'WEI',
        station_pinyin: 'chengdudong',
        station_short: 'cdd',
        station_index: '',
        code: '1707',
        city: '成都',
        r1: '',
        r2: '',
    },
];
let STATIONS = {}; //以Code为键
let CITY_STATIONS = {}; //以城市名名为键，位于该城市的的所有Station列表的记录
let CITY_CODES = {}; //以城市名名为键的Station记录
let NAME_STATIONS = {}; //以车站名为键的Station记录
function buildStationMaps() {
    const cityStations = {};
    for (const station of Object.values(STATIONS)) {
        const city = station.city;
        if (!cityStations[city]) {
            cityStations[city] = [];
        }
        cityStations[city].push({
            station_code: station.station_code,
            station_name: station.station_name,
        });
    }
    const cityCodes = {};
    for (const [city, stations] of Object.entries(cityStations)) {
        for (const station of stations) {
            if (station.station_name == city) {
                cityCodes[city] = station;
                break;
            }
        }
    }
    const nameStations = {};
    for (const station of Object.values(STATIONS)) {
        const station_name = station.station_name;
        nameStations[station_name] = {
            station_code: station.station_code,
            station_name: station.station_name,
        };
    }
    CITY_STATIONS = cityStations;
    CITY_CODES = cityCodes;
    NAME_STATIONS = nameStations;
}
/**
 * 懒加载站点数据与 12306 查询接口路径。
 * 启动阶段在后台预热、不阻塞 MCP 握手；各工具调用时 await 同一 Promise，
 * 保证站点表就绪后再查询（见 issue #67/#68）。
 */
let initializationPromise = null;
async function ensureInitialized() {
    if (!initializationPromise) {
        initializationPromise = (async () => {
            let success = true;
            try {
                STATIONS = await getStations();
                buildStationMaps();
            }
            catch (error) {
                console.error('Failed to load station list:', error);
                success = false;
            }
            try {
                LCQUERY_PATH = await getLCQueryPath();
            }
            catch (error) {
                console.error('Failed to resolve interline query path:', error);
                success = false;
            }
            try {
                TICKETS_QUERY_PATH = await getTicketQueryPath();
            }
            catch (error) {
                console.error('Failed to resolve ticket query path:', error);
                success = false;
            }
            return success;
        })();
    }
    return initializationPromise;
}
const SEAT_SHORT_TYPES = {
    swz: '商务座',
    tz: '特等座',
    zy: '一等座',
    ze: '二等座',
    gr: '高软卧',
    srrb: '动卧',
    rw: '软卧',
    yw: '硬卧',
    rz: '软座',
    yz: '硬座',
    wz: '无座',
    qt: '其他',
    gg: '',
    yb: '',
};
const SEAT_TYPES = {
    '9': { name: '商务座', short: 'swz' },
    P: { name: '特等座', short: 'tz' },
    M: { name: '一等座', short: 'zy' },
    D: { name: '优选一等座', short: 'zy' },
    O: { name: '二等座', short: 'ze' },
    S: { name: '二等包座', short: 'ze' },
    '6': { name: '高级软卧', short: 'gr' },
    A: { name: '高级动卧', short: 'gr' },
    '4': { name: '软卧', short: 'rw' },
    I: { name: '一等卧', short: 'rw' },
    F: { name: '动卧', short: 'rw' },
    '3': { name: '硬卧', short: 'yw' },
    J: { name: '二等卧', short: 'yw' },
    '2': { name: '软座', short: 'rz' },
    '1': { name: '硬座', short: 'yz' },
    W: { name: '无座', short: 'wz' },
    WZ: { name: '无座', short: 'wz' },
    H: { name: '其他', short: 'qt' },
};
const DW_FLAGS = [
    '智能动车组',
    '复兴号',
    '静音车厢',
    '温馨动卧',
    '动感号',
    '支持选铺',
    '老年优惠',
];
const TRAIN_FILTERS = {
    //G(高铁/城际),D(动车),Z(直达特快),T(特快),K(快速),O(其他),F(复兴号),S(智能动车组)
    G: (ticketInfo) => {
        return ticketInfo.start_train_code.startsWith('G') ||
            ticketInfo.start_train_code.startsWith('C')
            ? true
            : false;
    },
    D: (ticketInfo) => {
        return ticketInfo.start_train_code.startsWith('D') ? true : false;
    },
    Z: (ticketInfo) => {
        return ticketInfo.start_train_code.startsWith('Z') ? true : false;
    },
    T: (ticketInfo) => {
        return ticketInfo.start_train_code.startsWith('T') ? true : false;
    },
    K: (ticketInfo) => {
        return ticketInfo.start_train_code.startsWith('K') ? true : false;
    },
    O: (ticketInfo) => {
        return TRAIN_FILTERS.G(ticketInfo) ||
            TRAIN_FILTERS.D(ticketInfo) ||
            TRAIN_FILTERS.Z(ticketInfo) ||
            TRAIN_FILTERS.T(ticketInfo) ||
            TRAIN_FILTERS.K(ticketInfo)
            ? false
            : true;
    },
    F: (ticketInfo) => {
        if ('dw_flag' in ticketInfo) {
            return ticketInfo.dw_flag.includes('复兴号') ? true : false;
        }
        return ticketInfo.ticketList[0].dw_flag.includes('复兴号')
            ? true
            : false;
    },
    S: (ticketInfo) => {
        if ('dw_flag' in ticketInfo) {
            return ticketInfo.dw_flag.includes('智能动车组') ? true : false;
        }
        return ticketInfo.ticketList[0].dw_flag.includes('智能动车组')
            ? true
            : false;
    },
};
const TIME_COMPARETOR = {
    startTime: (ticketInfoA, ticketInfoB) => {
        const timeA = new Date(ticketInfoA.start_date);
        const timeB = new Date(ticketInfoB.start_date);
        if (timeA.getTime() != timeB.getTime()) {
            return timeA.getTime() - timeB.getTime();
        }
        const startTimeA = ticketInfoA.start_time.split(':');
        const startTimeB = ticketInfoB.start_time.split(':');
        const hourA = parseInt(startTimeA[0]);
        const hourB = parseInt(startTimeB[0]);
        if (hourA != hourB) {
            return hourA - hourB;
        }
        const minuteA = parseInt(startTimeA[1]);
        const minuteB = parseInt(startTimeB[1]);
        return minuteA - minuteB;
    },
    arriveTime: (ticketInfoA, ticketInfoB) => {
        const timeA = new Date(ticketInfoA.arrive_date);
        const timeB = new Date(ticketInfoB.arrive_date);
        if (timeA.getTime() != timeB.getTime()) {
            return timeA.getTime() - timeB.getTime();
        }
        const arriveTimeA = ticketInfoA.arrive_time.split(':');
        const arriveTimeB = ticketInfoB.arrive_time.split(':');
        const hourA = parseInt(arriveTimeA[0]);
        const hourB = parseInt(arriveTimeB[0]);
        if (hourA != hourB) {
            return hourA - hourB;
        }
        const minuteA = parseInt(arriveTimeA[1]);
        const minuteB = parseInt(arriveTimeB[1]);
        return minuteA - minuteB;
    },
    duration: (ticketInfoA, ticketInfoB) => {
        const lishiTimeA = ticketInfoA.lishi.split(':');
        const lishiTimeB = ticketInfoB.lishi.split(':');
        const hourA = parseInt(lishiTimeA[0]);
        const hourB = parseInt(lishiTimeB[0]);
        if (hourA != hourB) {
            return hourA - hourB;
        }
        const minuteA = parseInt(lishiTimeA[1]);
        const minuteB = parseInt(lishiTimeB[1]);
        return minuteA - minuteB;
    },
};
function parseCookies(cookies) {
    const cookieRecord = {};
    cookies.forEach((cookie) => {
        // 提取键值对部分（去掉 Path、HttpOnly 等属性）
        const keyValuePart = cookie.split(';')[0];
        // 分割键和值
        const [key, value] = keyValuePart.split('=');
        // 存入对象
        if (key && value) {
            cookieRecord[key.trim()] = value.trim();
        }
    });
    return cookieRecord;
}
function formatCookies(cookies) {
    return Object.entries(cookies)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ');
}
async function getCookie() {
    const url = `${API_BASE}/otn/leftTicket/init`;
    try {
        const response = await fetch(url);
        const setCookieHeader = response.headers.getSetCookie();
        if (setCookieHeader) {
            return parseCookies(setCookieHeader);
        }
        return null;
    }
    catch (error) {
        console.error('Error making 12306 request:', error);
        return null;
    }
}
function parseStationCode(station) {
    // 判断fromStation和toStation是中文名还是station_code，如果是中文名则转换为station_code，如果转换失败则fromStation或toStation置为null
    const regex = /^[A-Z]+$/;
    if (regex.test(station) && Object.keys(STATIONS).includes(station)) {
        return station;
    }
    else {
        station = station.endsWith('站')
            ? station.substring(0, station.length - 1)
            : station;
        if (Object.keys(NAME_STATIONS).includes(station)) {
            return NAME_STATIONS[station].station_code;
        }
    }
    return null;
}
function parseRouteStationsData(rawData) {
    const result = [];
    for (const item of rawData) {
        result.push(item);
    }
    return result;
}
function parseRouteStationsInfo(routeStationsData) {
    const result = [];
    routeStationsData.forEach((routeStationData, index) => {
        if (index == 0) {
            result.push({
                train_class_name: routeStationData.train_class_name,
                service_type: routeStationData.service_type,
                end_station_name: routeStationData.end_station_name,
                station_name: routeStationData.station_name,
                station_train_code: routeStationData.station_train_code,
                arrive_time: routeStationData.arrive_time,
                start_time: routeStationData.start_time,
                lishi: routeStationData.running_time,
                arrive_day_str: routeStationData.arrive_day_str,
            });
        }
        else {
            result.push({
                station_name: routeStationData.station_name,
                station_train_code: routeStationData.station_train_code,
                arrive_time: routeStationData.arrive_time,
                start_time: routeStationData.start_time,
                lishi: routeStationData.running_time,
                arrive_day_str: routeStationData.arrive_day_str,
            });
        }
    });
    return result;
}
function parseTicketsData(rawData) {
    const result = [];
    for (const item of rawData) {
        const values = item.split('|');
        const entry = {};
        TicketDataKeys.forEach((key, index) => {
            entry[key] = values[index];
        });
        result.push(entry);
    }
    return result;
}
function parseTicketsInfo(ticketsData, map, date) {
    const result = [];
    for (const ticket of ticketsData) {
        const prices = extractPrices(ticket.yp_info_new, ticket.seat_discount_info, ticket);
        const dw_flag = extractDWFlags(ticket.dw_flag);
        const startHours = parseInt(ticket.start_time.split(':')[0]);
        const startMinutes = parseInt(ticket.start_time.split(':')[1]);
        const durationHours = parseInt(ticket.lishi.split(':')[0]);
        const durationMinutes = parseInt(ticket.lishi.split(':')[1]);
        // 乘车日应使用查询日期，而不是列车的始发日期（start_train_date）：
        // 中途站上车或跨午夜时两者会不同（见 issue #72）。
        const startDate = parse(date, 'yyyy-MM-dd', new Date());
        startDate.setHours(startHours, startMinutes);
        const arriveDate = new Date(startDate);
        arriveDate.setHours(startHours + durationHours, startMinutes + durationMinutes);
        result.push({
            train_no: ticket.train_no,
            start_date: format(startDate, 'yyyy-MM-dd'),
            arrive_date: format(arriveDate, 'yyyy-MM-dd'),
            start_train_code: ticket.station_train_code,
            start_time: ticket.start_time,
            arrive_time: ticket.arrive_time,
            lishi: ticket.lishi,
            from_station: map[ticket.from_station_telecode],
            to_station: map[ticket.to_station_telecode],
            from_station_telecode: ticket.from_station_telecode,
            to_station_telecode: ticket.to_station_telecode,
            prices: prices,
            dw_flag: dw_flag,
        });
    }
    return result;
}
/**
 * 格式化票量信息，提供语义化描述
 * @param num 票量数字或状态字符串
 * @returns 格式化后的票量描述
 */
function formatTicketStatus(num) {
    // 检查是否为纯数字
    if (num.match(/^\d+$/)) {
        const count = parseInt(num);
        if (count === 0) {
            return '无票';
        }
        else {
            return `剩余${count}张票`;
        }
    }
    // 处理特殊状态字符串
    switch (num) {
        case '有':
        case '充足':
            return '有票';
        case '无':
        case '--':
        case '':
            return '无票';
        case '候补':
            return '无票需候补';
        default:
            return `${num}票`;
    }
}
function formatTicketsInfo(ticketsInfo) {
    if (ticketsInfo.length === 0) {
        return '没有查询到相关车次信息';
    }
    let result = '车次|出发站 -> 到达站|出发时间 -> 到达时间|历时\n';
    ticketsInfo.forEach((ticketInfo) => {
        let infoStr = '';
        infoStr += `${ticketInfo.start_train_code} ${ticketInfo.from_station}(telecode:${ticketInfo.from_station_telecode}) -> ${ticketInfo.to_station}(telecode:${ticketInfo.to_station_telecode}) ${ticketInfo.start_time} -> ${ticketInfo.arrive_time} 历时：${ticketInfo.lishi}`;
        ticketInfo.prices.forEach((price) => {
            const ticketStatus = formatTicketStatus(price.num);
            infoStr += `\n- ${price.seat_name}: ${ticketStatus} ${price.price}元`;
        });
        result += `${infoStr}\n`;
    });
    return result;
}
function formatTicketsInfoCSV(ticketsInfo) {
    if (ticketsInfo.length === 0) {
        return '没有查询到相关车次信息';
    }
    let result = '车次,出发站,到达站,出发时间,到达时间,历时,票价,特色标签\n';
    ticketsInfo.forEach((ticketInfo) => {
        let infoStr = '';
        infoStr += `${ticketInfo.start_train_code},${ticketInfo.from_station}(telecode:${ticketInfo.from_station_telecode}),${ticketInfo.to_station}(telecode:${ticketInfo.to_station_telecode}),${ticketInfo.start_time},${ticketInfo.arrive_time},${ticketInfo.lishi},[`;
        ticketInfo.prices.forEach((price) => {
            const ticketStatus = formatTicketStatus(price.num);
            infoStr += `${price.seat_name}: ${ticketStatus}${price.price}元,`;
        });
        infoStr += `],${ticketInfo.dw_flag.length == 0 ? '/' : ticketInfo.dw_flag.join('&')}`;
        result += `${infoStr}\n`;
    });
    return result;
}
function formatRouteStationsInfo(routeStationsInfo) {
    let result = `${routeStationsInfo[0].station_train_code}次列车（${routeStationsInfo[0].train_class_name} ${routeStationsInfo[0].service_type == '0' ? '无空调' : '有空调'}）\n站序|车站|车次|到达时间|出发时间|历时(hh:mm)\n`;
    routeStationsInfo.forEach((routeStationInfo, index) => {
        result += `${index + 1}|${routeStationInfo.station_name}|${routeStationInfo.station_train_code}|${routeStationInfo.arrive_time}|${routeStationInfo.start_time}|${routeStationInfo.arrive_day_str} ${routeStationInfo.lishi}\n`;
    });
    return result;
}
function filterTicketsInfo(ticketsInfo, trainFilterFlags, earliestStartTime = 0, latestStartTime = 24, sortFlag = '', sortReverse = false, limitedNum = 0) {
    let result;
    // FilterFlags过滤
    if (trainFilterFlags.length === 0) {
        result = ticketsInfo;
    }
    else {
        result = [];
        for (const ticketInfo of ticketsInfo) {
            for (const filter of trainFilterFlags) {
                if (TRAIN_FILTERS[filter](ticketInfo)) {
                    result.push(ticketInfo);
                    break;
                }
            }
        }
    }
    // startTime 过滤
    result = result.filter((ticketInfo) => {
        const startTimeHour = parseInt(ticketInfo.start_time.split(':')[0], 10);
        if (startTimeHour >= earliestStartTime &&
            startTimeHour < latestStartTime) {
            return true;
        }
        return false;
    });
    // sort排序
    if (Object.keys(TIME_COMPARETOR).includes(sortFlag)) {
        result.sort(TIME_COMPARETOR[sortFlag]);
        if (sortReverse) {
            result.reverse();
        }
    }
    if (limitedNum == 0) {
        return result;
    }
    return result.slice(0, limitedNum);
}
function parseInterlinesTicketInfo(interlineTicketsData, departureDates) {
    const result = [];
    for (let i = 0; i < interlineTicketsData.length; i++) {
        const interlineTicketData = interlineTicketsData[i];
        const prices = extractPrices(interlineTicketData.yp_info, interlineTicketData.seat_discount_info, interlineTicketData);
        const startHours = parseInt(interlineTicketData.start_time.split(':')[0]);
        const startMinutes = parseInt(interlineTicketData.start_time.split(':')[1]);
        const durationHours = parseInt(interlineTicketData.lishi.split(':')[0]);
        const durationMinutes = parseInt(interlineTicketData.lishi.split(':')[1]);
        // 第二段可能跨午夜：出发日期按行程推算（见 issue #72），
        // 而不是该列车的始发日期（start_train_date）。
        const startDate = new Date(departureDates[i]);
        startDate.setHours(startHours, startMinutes);
        const arriveDate = new Date(startDate);
        arriveDate.setHours(startHours + durationHours, startMinutes + durationMinutes);
        result.push({
            train_no: interlineTicketData.train_no,
            start_train_code: interlineTicketData.station_train_code,
            start_date: format(startDate, 'yyyy-MM-dd'),
            arrive_date: format(arriveDate, 'yyyy-MM-dd'),
            start_time: interlineTicketData.start_time,
            arrive_time: interlineTicketData.arrive_time,
            lishi: interlineTicketData.lishi,
            from_station: interlineTicketData.from_station_name,
            to_station: interlineTicketData.to_station_name,
            from_station_telecode: interlineTicketData.from_station_telecode,
            to_station_telecode: interlineTicketData.to_station_telecode,
            prices: prices,
            dw_flag: extractDWFlags(interlineTicketData.dw_flag),
        });
    }
    return result;
}
function parseInterlinesInfo(interlineData, date) {
    const result = [];
    for (const ticket of interlineData) {
        if (ticket.fullList.length < 2) {
            console.warn(`Interline result with less than 2 legs skipped (${ticket.first_train_no}).`);
            continue;
        }
        // 中转日期按行程推算：第一段出发 -> 第一段到达 -> 换乘等待 -> 第二段出发/到达。
        // 不能直接使用各段的始发日期（start_train_date），跨午夜时会差一天（见 issue #72）。
        const firstDeparture = parseDateWithTime(date, ticket.fullList[0].start_time);
        const firstArrival = addMinutes(firstDeparture, durationMinutes(ticket.fullList[0].lishi));
        const waitMinutes = ticket.wait_time_minutes > 0
            ? ticket.wait_time_minutes
            : parseWaitMinutes(ticket.wait_time);
        const secondDeparture = addMinutes(firstArrival, waitMinutes);
        const secondArrival = addMinutes(secondDeparture, durationMinutes(ticket.fullList[1].lishi));
        // 与上游摘要做一致性校验：不一致时以本地推算为准并记录日志
        if (format(secondDeparture, 'yyyy-MM-dd') !== ticket.middle_date ||
            format(secondArrival, 'yyyy-MM-dd') !== ticket.arrive_date) {
            console.warn(`Interline date mismatch (${ticket.first_train_no}/${ticket.second_train_no}): ` +
                `upstream middle=${ticket.middle_date} arrive=${ticket.arrive_date}, ` +
                `computed second departure=${formatDateTime(secondDeparture)}, ` +
                `arrival=${formatDateTime(secondArrival)}`);
        }
        const interlineTickets = parseInterlinesTicketInfo(ticket.fullList, [
            firstDeparture,
            secondDeparture,
        ]);
        const lishi = extractLishi(ticket.all_lishi);
        result.push({
            lishi: lishi,
            start_time: ticket.start_time,
            start_date: format(firstDeparture, 'yyyy-MM-dd'),
            middle_date: format(secondDeparture, 'yyyy-MM-dd'),
            arrive_date: format(secondArrival, 'yyyy-MM-dd'),
            arrive_time: ticket.arrive_time,
            from_station_code: ticket.from_station_code,
            from_station_name: ticket.from_station_name,
            middle_station_code: ticket.middle_station_code,
            middle_station_name: ticket.middle_station_name,
            end_station_code: ticket.end_station_code,
            end_station_name: ticket.end_station_name,
            start_train_code: interlineTickets[0].start_train_code,
            first_train_no: ticket.first_train_no,
            second_train_no: ticket.second_train_no,
            train_count: ticket.train_count,
            ticketList: interlineTickets,
            same_station: ticket.same_station == '0' ? true : false,
            same_train: ticket.same_train == 'Y' ? true : false,
            wait_time: ticket.wait_time,
        });
    }
    return result;
}
function formatInterlinesInfo(interlinesInfo) {
    let result = '出发时间 -> 到达时间 | 出发车站 -> 中转车站 -> 到达车站 | 换乘标志 |换乘等待时间| 总历时\n\n';
    interlinesInfo.forEach((interlineInfo) => {
        result += `${interlineInfo.start_date} ${interlineInfo.start_time} -> ${interlineInfo.arrive_date} ${interlineInfo.arrive_time} | `;
        result += `${interlineInfo.from_station_name} -> ${interlineInfo.middle_station_name} -> ${interlineInfo.end_station_name} | `;
        result += `${interlineInfo.same_train
            ? '同车换乘'
            : interlineInfo.same_station
                ? '同站换乘'
                : '换站换乘'} | ${interlineInfo.wait_time} | ${interlineInfo.lishi}\n\n`;
        result +=
            '\t' +
                formatTicketsInfo(interlineInfo.ticketList).replace(/\n/g, '\n\t');
        result += '\n';
    });
    return result;
}
function parseStationsData(rawData) {
    const result = {};
    const dataArray = rawData.split('|');
    const dataList = [];
    for (let i = 0; i < Math.floor(dataArray.length / 10); i++) {
        dataList.push(dataArray.slice(i * 10, i * 10 + 10));
    }
    for (const group of dataList) {
        let station = {};
        StationDataKeys.forEach((key, index) => {
            station[key] = group[index];
        });
        if (!station.station_code) {
            continue;
        }
        result[station.station_code] = station;
    }
    return result;
}
function extractPrices(yp_info, seat_discount_info, ticketData) {
    const PRICE_STR_LENGTH = 10;
    const DISCOUNT_STR_LENGTH = 5;
    const prices = [];
    const discounts = {};
    for (let i = 0; i < seat_discount_info.length / DISCOUNT_STR_LENGTH; i++) {
        const discount_str = seat_discount_info.slice(i * DISCOUNT_STR_LENGTH, (i + 1) * DISCOUNT_STR_LENGTH);
        discounts[discount_str[0]] = parseInt(discount_str.slice(1), 10);
    }
    for (let i = 0; i < yp_info.length / PRICE_STR_LENGTH; i++) {
        const price_str = yp_info.slice(i * PRICE_STR_LENGTH, (i + 1) * PRICE_STR_LENGTH);
        var seat_type_code;
        if (parseInt(price_str.slice(6, 10), 10) >= 3000) {
            // 根据12306的js逆向出来的，不懂。
            seat_type_code = 'W'; // 为无座
        }
        else if (!Object.keys(SEAT_TYPES).includes(price_str[0])) {
            seat_type_code = 'H'; // 其他坐席
        }
        else {
            seat_type_code = price_str[0];
        }
        const seat_type = SEAT_TYPES[seat_type_code];
        const price = parseInt(price_str.slice(1, 6), 10) / 10;
        const discount = seat_type_code in discounts ? discounts[seat_type_code] : null;
        prices.push({
            seat_name: seat_type.name,
            short: seat_type.short,
            seat_type_code,
            num: ticketData[`${seat_type.short}_num`],
            price,
            discount,
        });
    }
    return prices;
}
function extractDWFlags(dw_flag_str) {
    const dwFlagList = dw_flag_str.split('#');
    let result = [];
    if ('5' == dwFlagList[0]) {
        result.push(DW_FLAGS[0]);
    }
    if (dwFlagList.length > 1 && '1' == dwFlagList[1]) {
        result.push(DW_FLAGS[1]);
    }
    if (dwFlagList.length > 2) {
        if ('Q' == dwFlagList[2].substring(0, 1)) {
            result.push(DW_FLAGS[2]);
        }
        else if ('R' == dwFlagList[2].substring(0, 1)) {
            result.push(DW_FLAGS[3]);
        }
    }
    if (dwFlagList.length > 5 && 'D' == dwFlagList[5]) {
        result.push(DW_FLAGS[4]);
    }
    if (dwFlagList.length > 6 && 'z' != dwFlagList[6]) {
        result.push(DW_FLAGS[5]);
    }
    if (dwFlagList.length > 7 && 'z' != dwFlagList[7]) {
        result.push(DW_FLAGS[6]);
    }
    return result;
}
function checkDate(date) {
    const timeZone = 'Asia/Shanghai';
    const nowInShanghai = toZonedTime(new Date(), timeZone);
    nowInShanghai.setHours(0, 0, 0, 0);
    const inputInShanghai = toZonedTime(new Date(date), timeZone);
    inputInShanghai.setHours(0, 0, 0, 0);
    return inputInShanghai >= nowInShanghai;
}
async function make12306Request(url, scheme = new URLSearchParams(), headers = {}) {
    try {
        const response = await axios.get(url + '?' + scheme.toString(), {
            headers: headers,
            // 避免网络异常时无限等待，快速失败以便上层返回明确错误（见 issue #67/#68）
            timeout: 15000,
        });
        return (await response.data);
    }
    catch (error) {
        console.error('Error making 12306 request:', error);
        return null;
    }
}
function createServer() {
    return new McpServer({
        name: '12306-mcp',
        version: VERSION,
    }, {
        capabilities: {
            resources: {},
            tools: {},
        },
        instructions: '该服务主要用于帮助用户查询12306的车票信息、特定列车的经停站信息以及相关的车站信息。请仔细理解用户的意图，并按以下指引选择合适的接口：\n\n' +
            '**原则：**\n' +
            '*   **必要时追问**：如果用户信息不足以调用接口，请向用户追问缺失的信息。\n' +
            '*   **尽量精确需求**：尽量利用筛选功能筛选用户需要的车票信息，从而简短上下文长度。\n\n' +
            '请根据上述指引选择接口。',
    });
}
export const server = createServer();
const toolRegistrations = [];
const registerTool = ((...args) => {
    const registration = (target) => {
        Reflect.apply(target.tool, target, args);
    };
    registration(server);
    toolRegistrations.push(registration);
});
server.resource('stations', 'data://all-stations', async (uri) => {
    await ensureInitialized();
    return {
        contents: [{ uri: uri.href, text: JSON.stringify(STATIONS) }],
    };
});
registerTool('get-current-date', '获取当前日期，以上海时区（Asia/Shanghai, UTC+8）为准，返回格式为 "yyyy-MM-dd"。主要用于解析用户提到的相对日期（如“明天”、“下周三”），提供准确的日期输入。', {}, async () => {
    try {
        const timeZone = 'Asia/Shanghai';
        const nowInShanghai = toZonedTime(new Date(), timeZone);
        const formattedDate = format(nowInShanghai, 'yyyy-MM-dd');
        return {
            content: [{ type: 'text', text: formattedDate }],
        };
    }
    catch (error) {
        console.error('Error getting current date:', error);
        return {
            content: [
                {
                    type: 'text',
                    text: 'Error: Failed to get current date.',
                },
            ],
        };
    }
});
registerTool('get-stations-code-in-city', '通过中文城市名查询该城市 **所有** 火车站的名称及其对应的 `station_code`，结果是一个包含多个车站信息的列表。', {
    city: z.string().describe('中文城市名称，例如："北京", "上海"'),
}, async ({ city }) => {
    await ensureInitialized();
    if (Object.keys(STATIONS).length === 0) {
        return {
            content: [
                {
                    type: 'text',
                    text: 'Error: 站点数据加载失败，请检查网络后重试。',
                },
            ],
        };
    }
    if (!Object.prototype.hasOwnProperty.call(CITY_STATIONS, city)) {
        return {
            content: [{ type: 'text', text: 'Error: City not found. ' }],
        };
    }
    return {
        content: [
            { type: 'text', text: JSON.stringify(CITY_STATIONS[city]) },
        ],
    };
});
registerTool('get-station-code-of-citys', '通过中文城市名查询代表该城市的 `station_code`。', {
    citys: z
        .string()
        .describe('要查询的城市，比如"北京"。若要查询多个城市，请用|分割，比如"北京|上海"。'),
}, async ({ citys }) => {
    await ensureInitialized();
    if (Object.keys(STATIONS).length === 0) {
        return {
            content: [
                {
                    type: 'text',
                    text: 'Error: 站点数据加载失败，请检查网络后重试。',
                },
            ],
        };
    }
    const result = {};
    // 仅接受中文城市名：避免原样回显任意文本（XSS）与原型链污染（见 issue #74）
    for (const city of citys.split('|').slice(0, 20)) {
        if (!/^[\u4e00-\u9fff]{1,20}$/.test(city)) {
            continue;
        }
        if (!Object.prototype.hasOwnProperty.call(CITY_CODES, city)) {
            result[city] = { error: '未检索到城市。' };
        }
        else {
            result[city] = CITY_CODES[city];
        }
    }
    if (Object.keys(result).length === 0) {
        return {
            content: [
                { type: 'text', text: 'Error: 未提供有效的城市名。' },
            ],
        };
    }
    return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
    };
});
registerTool('get-station-code-by-names', '通过具体的中文车站名查询其 `station_code` 和车站名。', {
    stationNames: z
        .string()
        .describe('具体的中文车站名称，例如："北京南", "上海虹桥"。若要查询多个站点，请用|分割，比如"北京南|上海虹桥"。'),
}, async ({ stationNames }) => {
    await ensureInitialized();
    if (Object.keys(STATIONS).length === 0) {
        return {
            content: [
                {
                    type: 'text',
                    text: 'Error: 站点数据加载失败，请检查网络后重试。',
                },
            ],
        };
    }
    const result = {};
    // 仅接受看起来像车站名的中文输入并限制数量，
    // 避免将任意文本原样回显（XSS）与原型链污染（见 issue #74）
    for (let stationName of stationNames.split('|').slice(0, 20)) {
        stationName = stationName.endsWith('站')
            ? stationName.substring(0, stationName.length - 1)
            : stationName;
        if (!/^[\u4e00-\u9fff]{1,20}$/.test(stationName)) {
            continue;
        }
        if (Object.prototype.hasOwnProperty.call(NAME_STATIONS, stationName)) {
            result[stationName] = NAME_STATIONS[stationName];
        }
        else {
            result[stationName] = { error: '未检索到车站。' };
        }
    }
    if (Object.keys(result).length === 0) {
        return {
            content: [
                { type: 'text', text: 'Error: 未提供有效的车站名。' },
            ],
        };
    }
    return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
    };
});
registerTool('get-station-by-telecode', '通过车站的 `station_telecode` 查询车站的详细信息，包括名称、拼音、所属城市等。此接口主要用于在已知 `telecode` 的情况下获取更完整的车站数据，或用于特殊查询及调试目的。一般用户对话流程中较少直接触发。', {
    stationTelecode: z
        .string()
        .describe('车站的 `station_telecode` (3位字母编码)'),
}, async ({ stationTelecode }) => {
    await ensureInitialized();
    if (Object.keys(STATIONS).length === 0) {
        return {
            content: [
                {
                    type: 'text',
                    text: 'Error: 站点数据加载失败，请检查网络后重试。',
                },
            ],
        };
    }
    if (!Object.prototype.hasOwnProperty.call(STATIONS, stationTelecode)) {
        return {
            content: [{ type: 'text', text: 'Error: Station not found. ' }],
        };
    }
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify(STATIONS[stationTelecode]),
            },
        ],
    };
});
registerTool('get-tickets', '查询12306余票信息。', {
    date: z
        .string()
        .length(10)
        .describe('查询日期，格式为 "yyyy-MM-dd"。如果用户提供的是相对日期（如“明天”），请务必先调用 `get-current-date` 接口获取当前日期，并计算出目标日期。'),
    fromStation: z
        .string()
        .describe('出发地的中文名或站点的 `station_code`（可通过 `get-station-code-by-names` 或 `get-station-code-of-citys` 接口查询得到）'),
    toStation: z
        .string()
        .describe('到达地的中文名或站点的 `station_code`（可通过 `get-station-code-by-names` 或 `get-station-code-of-citys` 接口查询得到）'),
    trainFilterFlags: z
        .string()
        .regex(/^[GDZTKOFS]*$/)
        .max(8)
        .optional()
        .default('')
        .describe('车次筛选条件，默认为空，即不筛选。支持多个标志同时筛选。例如用户说“高铁票”，则应使用 "G"。可选标志：[G(高铁/城际),D(动车),Z(直达特快),T(特快),K(快速),O(其他),F(复兴号),S(智能动车组)]'),
    earliestStartTime: z
        .number()
        .min(0)
        .max(24)
        .optional()
        .default(0)
        .describe('最早出发时间（0-24），默认为0。'),
    latestStartTime: z
        .number()
        .min(0)
        .max(24)
        .optional()
        .default(24)
        .describe('最迟出发时间（0-24），默认为24。'),
    sortFlag: z
        .string()
        .optional()
        .default('')
        .describe('排序方式，默认为空，即不排序。仅支持单一标识。可选标志：[startTime(出发时间从早到晚), arriveTime(抵达时间从早到晚), duration(历时从短到长)]'),
    sortReverse: z
        .boolean()
        .optional()
        .default(false)
        .describe('是否逆向排序结果，默认为false。仅在设置了sortFlag时生效。'),
    limitedNum: z
        .number()
        .min(0)
        .optional()
        .default(0)
        .describe('返回的余票数量限制，默认为0，即不限制。'),
    format: z
        .string()
        .regex(/^(text|csv|json)$/i)
        .default('text')
        .optional()
        .describe('返回结果格式，默认为text，建议使用text与csv。可选标志：[text, csv, json]'),
}, async ({ date, fromStation, toStation, trainFilterFlags, earliestStartTime, latestStartTime, sortFlag, sortReverse, limitedNum, format, }) => {
    // 检查日期是否早于当前日期
    if (!checkDate(date)) {
        return {
            content: [
                {
                    type: 'text',
                    text: 'Error: The date cannot be earlier than today.',
                },
            ],
        };
    }
    const initialized = await ensureInitialized();
    if (!initialized) {
        return {
            content: [
                {
                    type: 'text',
                    text: 'Error: 无法初始化 12306 数据（站点表或查询接口路径加载失败），请检查网络后重试。',
                },
            ],
        };
    }
    const fromStationResult = parseStationCode(fromStation);
    const toStationResult = parseStationCode(toStation);
    if (fromStationResult === null || toStationResult === null) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error: Station not found. FromStationResult: ${fromStationResult}, ToStationResult: ${toStationResult}.`,
                },
            ],
        };
    }
    fromStation = fromStationResult;
    toStation = toStationResult;
    const queryParams = new URLSearchParams({
        'leftTicketDTO.train_date': date,
        'leftTicketDTO.from_station': fromStation,
        'leftTicketDTO.to_station': toStation,
        purpose_codes: 'ADULT',
    });
    const queryUrl = `${API_BASE}/otn/${TICKETS_QUERY_PATH}`;
    const cookies = await getCookie();
    if (cookies == null || Object.entries(cookies).length === 0) {
        return {
            content: [
                {
                    type: 'text',
                    text: 'Error: get cookie failed. Check your network.',
                },
            ],
        };
    }
    const queryResponse = await make12306Request(queryUrl, queryParams, { Cookie: formatCookies(cookies) });
    if (queryResponse === null || queryResponse === undefined) {
        return {
            content: [
                { type: 'text', text: 'Error: get tickets data failed. ' },
            ],
        };
    }
    const ticketsData = parseTicketsData(queryResponse.data.result);
    let ticketsInfo;
    try {
        ticketsInfo = parseTicketsInfo(ticketsData, queryResponse.data.map, date);
    }
    catch (error) {
        console.error('Error: parse tickets info failed. ', error);
        return {
            content: [
                {
                    type: 'text',
                    text: 'Error: parse tickets info failed. ',
                },
            ],
        };
    }
    // 上游可能返回同城其他站的车次，必须在排序与截断之前按实际起终点过滤（见 issue #72）
    ticketsInfo = ticketsInfo.filter((ticketInfo) => ticketInfo.from_station_telecode === fromStation &&
        ticketInfo.to_station_telecode === toStation);
    const filteredTicketsInfo = filterTicketsInfo(ticketsInfo, trainFilterFlags, earliestStartTime, latestStartTime, sortFlag, sortReverse, limitedNum);
    var formatedResult;
    switch (format) {
        case 'csv':
            formatedResult = formatTicketsInfoCSV(filteredTicketsInfo);
            break;
        case 'json':
            formatedResult = JSON.stringify(filteredTicketsInfo);
            break;
        default:
            formatedResult = formatTicketsInfo(filteredTicketsInfo);
            break;
    }
    return {
        content: [
            {
                type: 'text',
                text: formatedResult,
            },
        ],
    };
});
// https://kyfw.12306.cn/lcquery/queryG?
// train_date=2025-05-10&
// from_station_telecode=CDW&
// to_station_telecode=ZGE&
// middle_station=&
// result_index=0&
// can_query=Y&
// isShowWZ=N&
// purpose_codes=00&
// channel=E  ?channel是什么用的
registerTool('get-interline-tickets', '查询12306中转余票信息。尚且只支持查询前十条。', {
    date: z
        .string()
        .length(10)
        .describe('查询日期，格式为 "yyyy-MM-dd"。如果用户提供的是相对日期（如“明天”），请务必先调用 `get-current-date` 接口获取当前日期，并计算出目标日期。'),
    fromStation: z
        .string()
        .describe('出发地的中文名或站点的 `station_code`（可通过 `get-station-code-by-names` 或 `get-station-code-of-citys` 接口查询得到）'),
    toStation: z
        .string()
        .describe('到达地的中文名或站点的 `station_code`（可通过 `get-station-code-by-names` 或 `get-station-code-of-citys` 接口查询得到）'),
    middleStation: z
        .string()
        .optional()
        .default('')
        .describe('中转地的中文或站点的 `station_code`（可通过 `get-station-code-by-names` 或 `get-station-code-of-citys` 接口查询得到）。该参数可选。'),
    showWZ: z
        .boolean()
        .optional()
        .default(false)
        .describe('是否显示无座车，默认不显示无座车。'),
    trainFilterFlags: z
        .string()
        .regex(/^[GDZTKOFS]*$/)
        .max(8)
        .optional()
        .default('')
        .describe('车次筛选条件，默认为空。从以下标志中选取多个条件组合[G(高铁/城际),D(动车),Z(直达特快),T(特快),K(快速),O(其他),F(复兴号),S(智能动车组)]'),
    earliestStartTime: z
        .number()
        .min(0)
        .max(24)
        .optional()
        .default(0)
        .describe('最早出发时间（0-24），默认为0。'),
    latestStartTime: z
        .number()
        .min(0)
        .max(24)
        .optional()
        .default(24)
        .describe('最迟出发时间（0-24），默认为24。'),
    sortFlag: z
        .string()
        .optional()
        .default('')
        .describe('排序方式，默认为空，即不排序。仅支持单一标识。可选标志：[startTime(出发时间从早到晚), arriveTime(抵达时间从早到晚), duration(历时从短到长)]'),
    sortReverse: z
        .boolean()
        .optional()
        .default(false)
        .describe('是否逆向排序结果，默认为false。仅在设置了sortFlag时生效。'),
    limitedNum: z
        .number()
        .min(1)
        .optional()
        .default(10)
        .describe('返回的中转余票数量限制，默认为10。'),
    format: z
        .string()
        .regex(/^(text|json)$/i)
        .default('text')
        .optional()
        .describe('返回结果格式，默认为text，建议使用text。可选标志：[text, json]'),
}, async ({ date, fromStation, toStation, middleStation, showWZ, trainFilterFlags, earliestStartTime, latestStartTime, sortFlag, sortReverse, limitedNum, format, }) => {
    // 检查日期是否早于当前日期
    if (!checkDate(date)) {
        return {
            content: [
                {
                    type: 'text',
                    text: 'Error: The date cannot be earlier than today.',
                },
            ],
        };
    }
    const initialized = await ensureInitialized();
    if (!initialized) {
        return {
            content: [
                {
                    type: 'text',
                    text: 'Error: 无法初始化 12306 数据（站点表或查询接口路径加载失败），请检查网络后重试。',
                },
            ],
        };
    }
    const fromStationResult = parseStationCode(fromStation);
    const toStationResult = parseStationCode(toStation);
    const middleStationResult = parseStationCode(middleStation);
    if (fromStationResult === null ||
        toStationResult === null ||
        (middleStation !== '' && middleStationResult === null)) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error: Station not found. FromStationResult: ${fromStationResult}, ToStationResult: ${toStationResult}, MiddleStationResult: ${middleStationResult}`,
                },
            ],
        };
    }
    fromStation = fromStationResult;
    toStation = toStationResult;
    middleStation = middleStationResult ? middleStationResult : '';
    const queryUrl = `${API_BASE}${LCQUERY_PATH}`;
    const cookies = await getCookie();
    if (cookies == null || Object.entries(cookies).length === 0) {
        return {
            content: [
                {
                    type: 'text',
                    text: 'Error: get cookie failed. Check your network.',
                },
            ],
        };
    }
    var interlineData = [];
    const queryParams = new URLSearchParams({
        train_date: date,
        from_station_telecode: fromStation,
        to_station_telecode: toStation,
        middle_station: middleStation,
        result_index: '0',
        can_query: 'Y',
        isShowWZ: showWZ ? 'Y' : 'N',
        purpose_codes: '00', // 00: 成人票 0X: 学生票
        channel: 'E', // 没搞清楚什么用
    });
    while (interlineData.length < limitedNum) {
        const queryResponse = await make12306Request(queryUrl, queryParams, { Cookie: formatCookies(cookies) });
        // 处理请求错误
        if (queryResponse === null || queryResponse === undefined) {
            return {
                content: [
                    {
                        type: 'text',
                        text: 'Error: request interline tickets data failed. ',
                    },
                ],
            };
        }
        // 请求成功，但查询有误
        if (typeof queryResponse.data == 'string') {
            return {
                content: [
                    {
                        type: 'text',
                        text: `很抱歉，未查到相关的列车余票。(${queryResponse.errorMsg})`,
                    },
                ],
            };
        }
        interlineData = interlineData.concat(queryResponse.data.middleList);
        if (queryResponse.data.can_query == 'N') {
            break;
        }
        queryParams.set('result_index', queryResponse.data.result_index.toString());
    }
    // 请求和查询都没问题
    let interlineTicketsInfo;
    try {
        interlineTicketsInfo = parseInterlinesInfo(interlineData, date);
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error: parse tickets info failed. ${error}`,
                },
            ],
        };
    }
    // 过滤实际起终点：上游可能混入同城其他站（如到达上海站而非上海虹桥）（见 issue #72）
    interlineTicketsInfo = interlineTicketsInfo.filter((interlineInfo) => {
        const [first, second] = interlineInfo.ticketList;
        if (!first || !second) {
            return false;
        }
        if (first.from_station_telecode !== fromStation) {
            return false;
        }
        if (second.to_station_telecode !== toStation) {
            return false;
        }
        if (middleStation !== '') {
            return (first.to_station_telecode === middleStation &&
                second.from_station_telecode === middleStation);
        }
        return true;
    });
    const filteredInterlineTicketsInfo = filterTicketsInfo(interlineTicketsInfo, trainFilterFlags, earliestStartTime, latestStartTime, sortFlag, sortReverse, limitedNum);
    var formatedResult;
    switch (format) {
        case 'json':
            formatedResult = JSON.stringify(filteredInterlineTicketsInfo);
            break;
        default:
            formatedResult = formatInterlinesInfo(filteredInterlineTicketsInfo);
            break;
    }
    return {
        content: [
            {
                type: 'text',
                text: formatedResult,
            },
        ],
    };
});
registerTool('get-train-route-stations', '查询特定列车车次在指定区间内的途径车站、到站时间、出发时间及停留时间等详细经停信息。当用户询问某趟具体列车的经停站时使用此接口。', {
    trainCode: z
        .string()
        .describe('要查询的车次 `train_code`，例如"G1033"。'),
    departDate: z
        .string()
        .length(10)
        .describe('列车出发的日期 (格式: yyyy-MM-dd)。如果用户提供的是相对日期，请务必先调用 `get-current-date` 解析。'),
    format: z
        .string()
        .regex(/^(text|json)$/i)
        .default('text')
        .optional()
        .describe('返回结果格式，默认为text，建议使用text。可选标志：[text, json]'),
}, async ({ trainCode, departDate, format }) => {
    const searchParams = new URLSearchParams({
        keyword: trainCode,
        date: departDate.replaceAll('-', ''),
    });
    const searchUrl = `${SEARCH_API_BASE}/search/v1/train/search`;
    const searchResponse = await make12306Request(searchUrl, searchParams);
    if (searchResponse == null ||
        searchResponse.data.length == 0 ||
        searchResponse.data == undefined) {
        return {
            content: [
                {
                    type: 'text',
                    text: '很抱歉，未查询到对应车次。',
                },
            ],
        };
    }
    const searchData = searchResponse.data[0];
    const queryParams = new URLSearchParams({
        'leftTicketDTO.train_no': searchData.train_no,
        'leftTicketDTO.train_date': departDate,
        rand_code: '',
    });
    const queryUrl = `${API_BASE}/otn/queryTrainInfo/query`;
    const cookies = await getCookie();
    if (cookies == null || Object.entries(cookies).length === 0) {
        return {
            content: [
                {
                    type: 'text',
                    text: 'Error: get cookie failed. Check your network.',
                },
            ],
        };
    }
    const queryResponse = await make12306Request(queryUrl, queryParams, { Cookie: formatCookies(cookies) });
    if (queryResponse == null || queryResponse.data == undefined) {
        return {
            content: [
                {
                    type: 'text',
                    text: 'Error: get train route stations failed. ',
                },
            ],
        };
    }
    const routeStationsInfo = parseRouteStationsInfo(queryResponse.data.data);
    if (routeStationsInfo.length == 0) {
        return {
            content: [{ type: 'text', text: '未查询到相关车次信息。' }],
        };
    }
    var formatedResult;
    switch (format) {
        case 'json':
            formatedResult = JSON.stringify(routeStationsInfo);
            break;
        default:
            formatedResult = formatRouteStationsInfo(routeStationsInfo);
            break;
    }
    return {
        content: [{ type: 'text', text: formatedResult }],
    };
});
async function getStations() {
    const html = await make12306Request(WEB_URL);
    if (html == null) {
        throw new Error('Error: get 12306 web page failed.');
    }
    const match = html.match('.(/script/core/common/station_name.+?.js)');
    if (match == null) {
        throw new Error('Error: get station name js file failed.');
    }
    const stationNameJSFilePath = match[0];
    const stationNameJS = await make12306Request(new URL(stationNameJSFilePath, WEB_URL));
    if (stationNameJS == null) {
        throw new Error('Error: get station name js file failed.');
    }
    const rawData = stationNameJS.replace('var station_names =\'', '').replace('\';', '');
    const stationsData = parseStationsData(rawData);
    // 加上缺失的车站信息
    for (const station of MISSING_STATIONS) {
        if (!stationsData[station.station_code]) {
            stationsData[station.station_code] = station;
        }
    }
    return stationsData;
}
async function getTicketQueryPath() {
    const html = await make12306Request(TICKETS_QUERY_INIT_URL, new URLSearchParams());
    if (html == null) {
        throw new Error('Error: get 12306 web page failed.');
    }
    const match = html.match(/ var CLeftTicketUrl = '(.+?)'/);
    if (match == null) {
        throw new Error('Error: get station name js file failed.');
    }
    return match[1];
}
async function getLCQueryPath() {
    const html = await make12306Request(LCQUERY_INIT_URL, new URLSearchParams(), {
        "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,zh-HK;q=0.7,en-US;q=0.6,en;q=0.5"
    });
    if (html == null) {
        throw new Error('Error: get 12306 web page failed.');
    }
    const match = html.match(/ var lc_search_url = '(.+?)'/);
    if (match == null) {
        throw new Error('Error: get station name js file failed.');
    }
    return match[1];
}
async function init() { }
program
    .name('mcp-server-12306')
    .description('MCP server for 12306')
    .version(VERSION)
    .option('--host <host>', 'host to bind server to. Default is 127.0.0.1 (localhost only). Use 0.0.0.0 to bind to all interfaces - that exposes the server publicly without authentication, use it only behind a reverse proxy.')
    .option('--port <port>', 'port to listen on for SSE and HTTP transport.')
    .action(async (options) => {
    try {
        await init();
        // 启动后在后台预热站点数据与接口路径，不阻塞 MCP 握手（见 issue #67/#68）
        void ensureInitialized().catch((error) => {
            console.error('Background initialization failed:', error);
        });
        if (options.port || options.host) {
            // 默认只监听本机，避免无意间将服务暴露到公网（见 issue #75）
            const host = options.host ?? '127.0.0.1';
            if (host === '0.0.0.0') {
                console.warn('[警告] 正在监听 0.0.0.0：该服务没有内置鉴权，直接暴露公网会导致他人盗用您的查询流量与出口 IP。请仅在带鉴权的反向代理之后使用 0.0.0.0。');
            }
            await startSseAndStreamableHttpMcpServer({
                host,
                port: options.port,
                // @ts-ignore
                createMcpServer: async () => {
                    const httpServer = createServer();
                    toolRegistrations.forEach((register) => register(httpServer));
                    return httpServer;
                },
            });
        }
        else {
            const transport = new StdioServerTransport();
            await server.connect(transport);
            console.error('12306 MCP Server running on stdio @Joooook');
        }
    }
    catch (error) {
        console.error('Fatal error in main():', error);
        process.exit(1);
    }
});
program.parse();

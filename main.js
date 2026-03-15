import React, { useEffect, useMemo, useReducer, useRef, useState } from 'https://esm.sh/react@18.3.1';
import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client';

const ZONES = [
  'Asia/Tokyo',
  'Europe/London',
  'America/New_York',
  'Europe/Berlin',
  'Australia/Sydney',
  'Asia/Singapore',
  'UTC',
];

const STORAGE_KEY = 'chrono-lab-state-v1';

const pad = (n, size = 2) => String(n).padStart(size, '0');

const fmtDate = (date, zone) =>
  new Intl.DateTimeFormat('ja-JP', {
    timeZone: zone,
    dateStyle: 'full',
  }).format(date);

function getParts(now, zone) {
  const p = new Intl.DateTimeFormat('en-GB', {
    hour12: false,
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);

  const map = Object.fromEntries(p.filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return map;
}

function formatClock(parts, hour12) {
  let h = parts.hour;
  let suffix = '';
  if (hour12) {
    suffix = h >= 12 ? ' PM' : ' AM';
    h = h % 12 || 12;
  }
  return `${pad(h)}:${pad(parts.minute)}:${pad(parts.second)}${suffix}`;
}

function useNow(stepMs = 200) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (t) => {
      if (t - last >= stepMs) {
        setNow(new Date());
        last = t;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stepMs]);
  return now;
}

function playBeep(pattern = [300, 450, 300]) {
  const ac = new AudioContext();
  const startAt = ac.currentTime + 0.02;
  let cursor = startAt;

  for (const ms of pattern) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 900;
    gain.gain.value = 0.0001;
    osc.connect(gain).connect(ac.destination);

    gain.gain.exponentialRampToValueAtTime(0.2, cursor + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, cursor + ms / 1000);

    osc.start(cursor);
    osc.stop(cursor + ms / 1000);
    cursor += ms / 1000 + 0.07;
  }

  setTimeout(() => ac.close(), (cursor - startAt) * 1000 + 600);
}

function createInitialState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      return {
        zone: parsed.zone || 'Asia/Tokyo',
        hour12: Boolean(parsed.hour12),
        alarms: Array.isArray(parsed.alarms) ? parsed.alarms : [],
        stopwatch: {
          running: false,
          offsetMs: 0,
          laps: [],
          startedAt: null,
        },
        timer: {
          running: false,
          durationSec: parsed.timer?.durationSec || 5 * 60,
          startedAt: null,
          remainSec: parsed.timer?.durationSec || 5 * 60,
        },
      };
    } catch {
      // ignore broken storage
    }
  }

  return {
    zone: 'Asia/Tokyo',
    hour12: false,
    alarms: [],
    stopwatch: { running: false, offsetMs: 0, laps: [], startedAt: null },
    timer: { running: false, durationSec: 5 * 60, startedAt: null, remainSec: 5 * 60 },
  };
}

function reducer(state, action) {
  switch (action.type) {
    case 'set-zone':
      return { ...state, zone: action.zone };
    case 'toggle-hour-format':
      return { ...state, hour12: !state.hour12 };
    case 'add-alarm':
      return { ...state, alarms: [...state.alarms, action.alarm] };
    case 'remove-alarm':
      return { ...state, alarms: state.alarms.filter((a) => a.id !== action.id) };
    case 'toggle-alarm':
      return {
        ...state,
        alarms: state.alarms.map((a) => (a.id === action.id ? { ...a, enabled: !a.enabled } : a)),
      };

    case 'sw-start':
      return {
        ...state,
        stopwatch: { ...state.stopwatch, running: true, startedAt: performance.now() },
      };
    case 'sw-stop': {
      const elapsed = action.now - state.stopwatch.startedAt;
      return {
        ...state,
        stopwatch: {
          ...state.stopwatch,
          running: false,
          startedAt: null,
          offsetMs: state.stopwatch.offsetMs + elapsed,
        },
      };
    }
    case 'sw-lap':
      return {
        ...state,
        stopwatch: { ...state.stopwatch, laps: [action.value, ...state.stopwatch.laps].slice(0, 8) },
      };
    case 'sw-reset':
      return { ...state, stopwatch: { running: false, offsetMs: 0, laps: [], startedAt: null } };

    case 'timer-set':
      return {
        ...state,
        timer: {
          ...state.timer,
          running: false,
          durationSec: action.sec,
          remainSec: action.sec,
          startedAt: null,
        },
      };
    case 'timer-start':
      return {
        ...state,
        timer: {
          ...state.timer,
          running: true,
          startedAt: Date.now(),
        },
      };
    case 'timer-stop':
      return {
        ...state,
        timer: {
          ...state.timer,
          running: false,
          remainSec: action.remainSec,
          startedAt: null,
        },
      };
    case 'timer-finish':
      return {
        ...state,
        timer: { ...state.timer, running: false, remainSec: 0, startedAt: null },
      };
    default:
      return state;
  }
}

function AnalogClock({ hour, minute, second }) {
  const secAngle = second * 6;
  const minAngle = minute * 6 + second * 0.1;
  const hourAngle = ((hour % 12) + minute / 60) * 30;

  return React.createElement(
    'div',
    { className: 'analog' },
    Array.from({ length: 60 }, (_, i) =>
      React.createElement('div', {
        key: i,
        className: `tick ${i % 5 === 0 ? 'main' : ''}`,
        style: { transform: `rotate(${i * 6}deg) translateY(-96px)` },
      }),
    ),
    React.createElement('div', { className: 'hand h', style: { transform: `rotate(${hourAngle}deg)` } }),
    React.createElement('div', { className: 'hand m', style: { transform: `rotate(${minAngle}deg)` } }),
    React.createElement('div', { className: 'hand s', style: { transform: `rotate(${secAngle}deg)` } }),
    React.createElement('div', { className: 'center' }),
  );
}

function App() {
  const [state, dispatch] = useReducer(reducer, null, createInitialState);
  const now = useNow(120);
  const [alarmInput, setAlarmInput] = useState('07:00');
  const firedRef = useRef('');

  const parts = useMemo(() => getParts(now, state.zone), [now, state.zone]);
  const localClock = formatClock(parts, state.hour12);

  const stopwatchMs = state.stopwatch.running
    ? state.stopwatch.offsetMs + (performance.now() - state.stopwatch.startedAt)
    : state.stopwatch.offsetMs;

  const remainSec = state.timer.running
    ? Math.max(0, state.timer.durationSec - Math.floor((Date.now() - state.timer.startedAt) / 1000))
    : state.timer.remainSec;

  useEffect(() => {
    const persist = {
      zone: state.zone,
      hour12: state.hour12,
      alarms: state.alarms,
      timer: { durationSec: state.timer.durationSec },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persist));
  }, [state.zone, state.hour12, state.alarms, state.timer.durationSec]);

  useEffect(() => {
    if (!state.timer.running) return;
    if (remainSec > 0) return;
    dispatch({ type: 'timer-finish' });
    playBeep([220, 220, 220, 440]);
  }, [state.timer.running, remainSec]);

  useEffect(() => {
    const token = `${parts.hour}:${parts.minute}`;
    if (firedRef.current === token) return;

    const hit = state.alarms.find(
      (a) => a.enabled && a.hour === parts.hour && a.minute === parts.minute && parts.second === 0,
    );
    if (hit) {
      firedRef.current = token;
      playBeep();
    }
  }, [parts.hour, parts.minute, parts.second, state.alarms]);

  const addAlarm = () => {
    const [h, m] = alarmInput.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return;
    dispatch({
      type: 'add-alarm',
      alarm: { id: crypto.randomUUID(), hour: h, minute: m, enabled: true },
    });
  };

  const timerFmt = `${pad(Math.floor(remainSec / 60))}:${pad(remainSec % 60)}`;
  const swFmt = `${pad(Math.floor(stopwatchMs / 60000))}:${pad(Math.floor((stopwatchMs % 60000) / 1000))}.${pad(
    Math.floor((stopwatchMs % 1000) / 10),
  )}`;

  return React.createElement(
    'main',
    { className: 'app' },
    React.createElement(
      'section',
      { className: 'card' },
      React.createElement('h2', { className: 'title' }, '🕒 Smart Zone Clock (React + Hooks)'),
      React.createElement('div', { className: 'time' }, localClock),
      React.createElement('div', { className: 'date' }, fmtDate(now, state.zone)),
      React.createElement(AnalogClock, { hour: parts.hour, minute: parts.minute, second: parts.second }),
      React.createElement(
        'div',
        { className: 'row' },
        React.createElement(
          'select',
          { value: state.zone, onChange: (e) => dispatch({ type: 'set-zone', zone: e.target.value }) },
          ZONES.map((z) => React.createElement('option', { key: z, value: z }, z)),
        ),
        React.createElement(
          'button',
          { className: 'secondary', onClick: () => dispatch({ type: 'toggle-hour-format' }) },
          state.hour12 ? '24h 表示' : '12h 表示',
        ),
      ),
    ),

    React.createElement(
      'section',
      { className: 'card' },
      React.createElement('h2', { className: 'title' }, '⏱️ 高機能ストップウォッチ'),
      React.createElement('div', { className: 'time' }, swFmt),
      React.createElement(
        'div',
        { className: 'row' },
        state.stopwatch.running
          ? React.createElement('button', { onClick: () => dispatch({ type: 'sw-stop', now: performance.now() }) }, '停止')
          : React.createElement('button', { onClick: () => dispatch({ type: 'sw-start' }) }, '開始'),
        React.createElement('button', { className: 'secondary', onClick: () => dispatch({ type: 'sw-lap', value: swFmt }) }, 'ラップ'),
        React.createElement('button', { className: 'danger', onClick: () => dispatch({ type: 'sw-reset' }) }, 'リセット'),
      ),
      React.createElement(
        'ul',
        null,
        state.stopwatch.laps.map((lap, i) =>
          React.createElement('li', { key: `${lap}-${i}` }, React.createElement('span', null, `Lap ${state.stopwatch.laps.length - i}`), React.createElement('strong', null, lap)),
        ),
      ),
    ),

    React.createElement(
      'section',
      { className: 'card' },
      React.createElement('h2', { className: 'title' }, '⏳ カウントダウンタイマー'),
      React.createElement('div', { className: 'time' }, timerFmt),
      React.createElement(
        'div',
        { className: 'grid2' },
        React.createElement('button', { className: 'secondary', onClick: () => dispatch({ type: 'timer-set', sec: 5 * 60 }) }, '5:00'),
        React.createElement('button', { className: 'secondary', onClick: () => dispatch({ type: 'timer-set', sec: 25 * 60 }) }, '25:00'),
        React.createElement('button', { className: 'secondary', onClick: () => dispatch({ type: 'timer-set', sec: 45 * 60 }) }, '45:00'),
        React.createElement('button', { className: 'danger', onClick: () => dispatch({ type: 'timer-set', sec: state.timer.durationSec }) }, 'リセット'),
      ),
      React.createElement(
        'div',
        { className: 'row', style: { marginTop: '8px' } },
        state.timer.running
          ? React.createElement('button', { onClick: () => dispatch({ type: 'timer-stop', remainSec }) }, '一時停止')
          : React.createElement('button', { onClick: () => dispatch({ type: 'timer-start' }) }, 'スタート'),
        React.createElement('span', { className: 'muted' }, '終了時にWeb Audioで通知'),
      ),
    ),

    React.createElement(
      'section',
      { className: 'card' },
      React.createElement('h2', { className: 'title' }, '🔔 アラーム管理'),
      React.createElement(
        'div',
        { className: 'row' },
        React.createElement('input', { type: 'time', value: alarmInput, onChange: (e) => setAlarmInput(e.target.value) }),
        React.createElement('button', { onClick: addAlarm }, '追加'),
      ),
      React.createElement(
        'ul',
        null,
        state.alarms.map((a) =>
          React.createElement(
            'li',
            { key: a.id },
            React.createElement('span', null, `${pad(a.hour)}:${pad(a.minute)}`),
            React.createElement(
              'div',
              { className: 'row' },
              React.createElement('button', { className: 'secondary', onClick: () => dispatch({ type: 'toggle-alarm', id: a.id }) }, a.enabled ? 'ON' : 'OFF'),
              React.createElement('button', { className: 'danger', onClick: () => dispatch({ type: 'remove-alarm', id: a.id }) }, '削除'),
            ),
          ),
        ),
      ),
    ),
  );
}

createRoot(document.getElementById('root')).render(React.createElement(App));

import { check, sleep } from 'k6';
import http from 'k6/http';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE = __ENV.BASE || 'http://127.0.0.1:8000';
const FILIAL = __ENV.LOAD_FILIAL;
const MASTER = __ENV.LOAD_MASTER;
const SERVICE = __ENV.LOAD_SERVICE;

export const options = {
  stages: [
    { duration: '10s', target: 2 },
    { duration: '20s', target: 3 },
    { duration: '5s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
    // бронь под конкуренцией честно возвращает 409, когда слот занят —
    // это не отказ сервиса, поэтому для неё свой порог
    'http_req_failed{name:book}': ['rate<0.6'],
    'http_req_duration{name:slots}': ['p(95)<200'],
  },
};

// auth — один раз на прогон, итерации меряют чтение (кэш Valkey против БД)
export function setup() {
  const email = `load-setup-${uuidv4()}@example.com`;
  let r = http.post(`${BASE}/api/v1/auth/register`, JSON.stringify({ email, password: 'secret123' }), {
    headers: { 'Content-Type': 'application/json' },
  });
  if (r.status !== 201) throw new Error(`register failed: ${r.status}`);
  r = http.post(`${BASE}/api/v1/auth/login`, JSON.stringify({ email, password: 'secret123' }), {
    headers: { 'Content-Type': 'application/json' },
  });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return { token: r.json().access_token };
}

export default function (data) {
  const H = { Authorization: `Bearer ${data.token}`, 'Content-Type': 'application/json' };

  let r = http.get(`${BASE}/`);
  check(r, { 'ssr ok': (x) => x.status === 200 });

  // случайный день из ближайших двух недель: фиксированный день выкупается
  // бронями за пару прогонов, и тест деградирует в одни 409
  const day = new Date(Date.now() + Math.floor(Math.random() * 14) * 86400000)
    .toISOString()
    .slice(0, 10);
  r = http.get(
    `${BASE}/api/v1/slots?filial_id=${FILIAL}&master_id=${MASTER}&service_id=${SERVICE}&day=${day}`,
    { tags: { name: 'slots' } }
  );
  check(r, { 'slots ok': (x) => x.status === 200 });
  const slots = r.json().slots || [];
  if (slots.length > 0) {
    const start = slots[Math.floor(Math.random() * slots.length)];
    r = http.post(
      `${BASE}/api/v1/bookings`,
      JSON.stringify({ master_id: MASTER, filial_id: FILIAL, service_id: SERVICE, start_at: start }),
      { headers: { ...H, 'Idempotency-Key': uuidv4() }, tags: { name: 'book' } }
    );
    check(r, { 'book ok/conflict': (x) => x.status === 201 || x.status === 409 });
    if (r.status === 201) {
      const bid = r.json().id;
      r = http.post(`${BASE}/api/v1/bookings/${bid}/cancel`, null, {
        headers: H,
        tags: { name: 'cancel' },
      });
      check(r, { 'cancel ok': (x) => x.status === 200 });
    }
  }
  sleep(1);
}

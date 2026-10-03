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
  },
};

export function setup() {
  return {};
}

export default function () {
  const email = `load${__VU}@example.com`;
  // регистрация идемпотентна по смыслу: повторный прогон VU пересоздаст — ок для нагрузки
  let r = http.post(`${BASE}/api/v1/auth/register`, JSON.stringify({ email, password: 'secret123' }), {
    headers: { 'Content-Type': 'application/json' },
  });
  if (r.status !== 201 && r.status !== 409) {
    check(r, { 'register ok': () => false });
    return;
  }
  r = http.post(`${BASE}/api/v1/auth/login`, JSON.stringify({ email, password: 'secret123' }), {
    headers: { 'Content-Type': 'application/json' },
  });
  check(r, { 'login ok': (x) => x.status === 200 });
  if (r.status !== 200) return;
  const token = r.json().access_token;
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  r = http.get(`${BASE}/`);
  check(r, { 'ssr ok': (x) => x.status === 200 });

  r = http.get(`${BASE}/api/v1/slots?filial_id=${FILIAL}&master_id=${MASTER}&service_id=${SERVICE}&day=2026-10-06`);
  check(r, { 'slots ok': (x) => x.status === 200 });
  const slots = r.json().slots || [];
  if (slots.length > 0) {
    const start = slots[Math.floor(Math.random() * slots.length)];
    const key = uuidv4();
    r = http.post(
      `${BASE}/api/v1/bookings`,
      JSON.stringify({ master_id: MASTER, filial_id: FILIAL, service_id: SERVICE, start_at: start }),
      { headers: { ...H, 'Idempotency-Key': key } }
    );
    check(r, { 'book ok/conflict': (x) => x.status === 201 || x.status === 409 });
    if (r.status === 201) {
      const bid = r.json().id;
      r = http.post(`${BASE}/api/v1/bookings/${bid}/cancel`, null, { headers: H });
      check(r, { 'cancel ok': (x) => x.status === 200 });
    }
  }
  sleep(1);
}

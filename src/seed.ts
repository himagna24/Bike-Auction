import { pool } from './db.js';
import { hashPassword } from './auth.js';

const users = [
  ['admin@bikes.test', 'Admin123!', 'ADMIN'],
  ['buyer1@bikes.test', 'Buyer123!', 'BUYER'],
  ['buyer2@bikes.test', 'Buyer123!', 'BUYER'],
  ['buyer3@bikes.test', 'Buyer123!', 'BUYER'],
] as const;

let adminId = '';
for (const [email, pw, role] of users) {
  const { rows } = await pool.query(
    `INSERT INTO users(email,password_hash,role) VALUES($1,$2,$3)
     ON CONFLICT (email) DO UPDATE SET role=EXCLUDED.role RETURNING id`, [email, await hashPassword(pw), role]);
  if (role === 'ADMIN') adminId = rows[0].id;
}

// [title, make, model, year, km, start, reserve, increment, startsInMin, endsInMin]
const bikes: [string, string, string, number, number, number, number | null, number, number, number][] = [
  ['Royal Enfield Classic 350', 'Royal Enfield', 'Classic 350', 2019, 18500, 9000000, 11000000, 50000, -60, 4320],
  ['Yamaha R15 V3', 'Yamaha', 'R15 V3', 2020, 12000, 11000000, null, 50000, -30, 1440],
  ['Honda CB350 H\'ness', 'Honda', 'CB350', 2021, 8000, 15000000, 16500000, 100000, -10, 12],
  ['KTM Duke 200', 'KTM', 'Duke 200', 2018, 31000, 7500000, 8500000, 50000, -120, 360],
  ['Bajaj Pulsar NS200', 'Bajaj', 'Pulsar NS200', 2017, 42000, 5000000, null, 25000, 30, 2880],
  ['TVS Apache RTR 160 4V', 'TVS', 'Apache RTR 160', 2022, 6000, 8500000, 9500000, 50000, 180, 4320],
];
await pool.query(`DELETE FROM bids; DELETE FROM auctions;`);
for (const [t, mk, md, y, km, sp, rp, inc, s, e] of bikes) {
  await pool.query(
    `INSERT INTO auctions(title,make,model,year,km,description,start_price_cents,reserve_price_cents,
       min_increment_cents,current_price_cents,starts_at,ends_at,status,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$7, now()+($10::int*interval '1 minute'), now()+($11::int*interval '1 minute'),
       CASE WHEN $10::int<=0 THEN 'LIVE' ELSE 'SCHEDULED' END, $12)`,
    [t, mk, md, y, km, 'Well maintained, single owner, all service records available.', sp, rp, inc, s, e, adminId]);
}
console.log('seeded. admin@bikes.test / Admin123!  buyer1..3@bikes.test / Buyer123!');
await pool.end();

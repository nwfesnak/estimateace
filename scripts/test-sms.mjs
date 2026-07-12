import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env.local');

function loadEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

function formatPhoneE164(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 11) return `+${digits}`;
  return null;
}

const env = loadEnv(envPath);
const sid = env.TWILIO_ACCOUNT_SID;
const token = env.TWILIO_AUTH_TOKEN;
const from = env.TWILIO_PHONE_NUMBER;

if (!sid || !token || !from) {
  console.error('Missing Twilio vars in .env.local:');
  if (!sid) console.error('  - TWILIO_ACCOUNT_SID');
  if (!token) console.error('  - TWILIO_AUTH_TOKEN');
  if (!from) console.error('  - TWILIO_PHONE_NUMBER');
  process.exit(1);
}

if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing Supabase URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data } = await supabase
  .from('estimates')
  .select('profile')
  .eq('jobName', '__settings__')
  .limit(1)
  .maybeSingle();

const contractorPhone = (data?.profile?.phone || '').trim();
if (!contractorPhone) {
  console.error('No company phone on Profile settings. Add your phone in Profile and save.');
  process.exit(1);
}

const to = formatPhoneE164(contractorPhone);
if (!to) {
  console.error(`Invalid company phone format: ${contractorPhone}`);
  process.exit(1);
}

const body = `EstimateAce SMS test — if you received this, Twilio is configured correctly.`;

const auth = Buffer.from(`${sid}:${token}`).toString('base64');
const params = new URLSearchParams({ To: to, From: from, Body: body });

console.log(`Sending test SMS to ${to} from ${from}...`);

const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
  method: 'POST',
  headers: {
    Authorization: `Basic ${auth}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: params.toString(),
});

const text = await response.text();
if (!response.ok) {
  console.error('SMS failed:', text);
  process.exit(1);
}

console.log('SMS sent successfully.');
console.log(text);
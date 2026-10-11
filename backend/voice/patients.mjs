import { z } from 'zod';
import { isTimeZone } from '../time.mjs';

export const E164 = /^\+[1-9]\d{7,14}$/;

export const patientsSchema = z.array(z.object({
  number: z.string().regex(E164),
  name: z.string().trim().min(1).max(60).optional(),
  caregiver: z.string().regex(E164).optional(),
  timeZone: z.string().refine(isTimeZone, 'Unknown IANA time zone').optional(),
}).strict()).max(50).refine(list => new Set(list.map(patient => patient.number)).size === list.length,
  'Each patient needs a distinct number');

// Everyone Steph serves. DEMO_CALLER_NUMBER stays the primary patient: records without an
// explicit `patient` (Google sync, camera, older data) belong to them, and so does CAREGIVER_NUMBER.
export function patientsFrom(config) {
  const primary = config.DEMO_CALLER_NUMBER || config.PATIENTS?.[0]?.number;
  const list = [...(config.PATIENTS ?? [])];
  if (primary && !list.some(patient => patient.number === primary)) list.unshift({ number: primary });
  return list.map(patient => ({
    ...patient,
    caregiver: patient.caregiver ?? (patient.number === primary ? config.CAREGIVER_NUMBER : undefined),
    primary: patient.number === primary,
  }));
}

// Who is on the line, from Dial's X-Dial-User-Number. Anything but an exact, known E.164
// number is refused: a missing or empty header, a template Dial did not fill, or a malformed value.
export function identifyCaller(patients, value) {
  if (!patients.length) return { reason: 'no_demo_caller' };
  const number = typeof value === 'string' ? value.trim() : '';
  if (!number) return { reason: 'no_caller_header' };
  if (/\{\{|\}\}/.test(number)) return { reason: 'unfilled_caller_header' };
  if (!E164.test(number)) return { reason: 'malformed_caller' };
  const patient = patients.find(candidate => candidate.number === number);
  return patient ? { patient } : { reason: 'unknown_caller' };
}

export function ownerOf(record, patients) {
  return record.patient ?? patients.find(patient => patient.primary)?.number;
}

// A store whose evidence reads only return this patient's records (none without a patient).
// Writes and the other tables pass through to the real store.
export function scopedStore(store, patient, patients) {
  return Object.create(store, {
    list: {
      value: async source => patient
        ? (await store.list(source)).filter(record => ownerOf(record, patients) === patient.number) : [],
    },
  });
}

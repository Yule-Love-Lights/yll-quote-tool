import { describe, it, expect } from 'vitest';
import { shapeMyDay, type MyDayAssignmentRow, type MyDayJobRow, type MyDayPropertyRow } from './myDay';

const job = (over: Partial<MyDayJobRow> = {}): MyDayJobRow => ({
  id: 'job-1',
  job_number: 1046,
  status: 'scheduled',
  property_id: 'prop-1',
  ...over,
});
const prop = (over: Partial<MyDayPropertyRow> = {}): MyDayPropertyRow => ({
  id: 'prop-1',
  address: '123 Birch Hill Rd, Locust Valley, NY',
  ...over,
});
const assignment = (over: Partial<MyDayAssignmentRow> = {}): MyDayAssignmentRow => ({
  id: 'a-1',
  job_id: 'job-1',
  assigned_date: '2026-08-29',
  ...over,
});

describe('shapeMyDay', () => {
  it('pairs each assignment with its job number and address', () => {
    expect(shapeMyDay([assignment()], [job()], [prop()])).toEqual([
      { assignmentId: 'a-1', jobId: 'job-1', jobNumber: 1046, status: 'scheduled', address: '123 Birch Hill Rd, Locust Valley, NY' },
    ]);
  });

  it('orders by job number so the list is stable between reloads', () => {
    const rows = shapeMyDay(
      [assignment({ id: 'a-2', job_id: 'job-2' }), assignment()],
      [job({ id: 'job-2', job_number: 1040, property_id: 'prop-2' }), job()],
      [prop(), prop({ id: 'prop-2', address: '9 Elm St' })],
    );
    expect(rows.map((r) => r.jobNumber)).toEqual([1040, 1046]);
  });

  // A crew member standing in a driveway needs the row even when a lookup is
  // thin: a missing address is shown as unknown, never a dropped job.
  it('keeps a job whose property or address is missing', () => {
    expect(shapeMyDay([assignment()], [job({ property_id: null })], [])).toEqual([
      { assignmentId: 'a-1', jobId: 'job-1', jobNumber: 1046, status: 'scheduled', address: null },
    ]);
  });

  it('drops an assignment whose job row is missing rather than inventing one', () => {
    expect(shapeMyDay([assignment({ job_id: 'ghost' })], [job()], [prop()])).toEqual([]);
  });

  // No payroll on this surface, by the workstream C constraint. The shape has
  // no money field at all, which is the only way to guarantee it.
  it('carries no money field of any kind', () => {
    const [row] = shapeMyDay([assignment()], [job()], [prop()]);
    expect(Object.keys(row!)).toEqual(['assignmentId', 'jobId', 'jobNumber', 'status', 'address']);
  });
});

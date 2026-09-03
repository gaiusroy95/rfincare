import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EMPLOYEE_ACCESS_MODULES } from '../../src/lib/employeeAccessControls.js';
import { terminateEmployee } from '../../src/lib/adminStaffManage.js';
import { commissionReportToXlsx } from '../../src/lib/commissionReportService.js';

describe('Employee Journey — ACL catalogue', () => {
  it('includes Marketing Leads in employee access modules', () => {
    const leads = EMPLOYEE_ACCESS_MODULES.find((m) => m.key === 'leads');
    assert.ok(leads);
    assert.equal(leads.label, 'Marketing Leads');
    const agents = EMPLOYEE_ACCESS_MODULES.find((m) => m.key === 'agents');
    assert.equal(agents.label, 'Agent Management');
  });
});

describe('Employee Journey — HR terminate helper', () => {
  it('exports terminateEmployee', () => {
    assert.equal(typeof terminateEmployee, 'function');
  });
});

describe('Employee Journey — agent report Excel', () => {
  it('builds a true xlsx buffer for commission reports', () => {
    const buf = commissionReportToXlsx({
      agent: { agentName: 'Test Agent', agentCode: 'AG001', email: 'a@example.com' },
      from: '2026-01-01',
      to: '2026-01-31',
      rows: [],
      totals: { files: 0, commission: 0 },
    });
    assert.ok(Buffer.isBuffer(buf) || buf instanceof Uint8Array);
    assert.ok(buf.length > 100);
    // ZIP/xlsx magic
    assert.equal(buf[0], 0x50);
    assert.equal(buf[1], 0x4b);
  });
});

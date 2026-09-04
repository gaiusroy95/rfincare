import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildMsg91WhatsappOtpComponents,
  getMsg91Config,
  normalizeIndianMobile,
} from '../../src/lib/msg91.js';

describe('MSG91 WhatsApp OTP helpers', () => {
  it('normalizes Indian mobiles to 10 digits', () => {
    assert.equal(normalizeIndianMobile('9680748057'), '9680748057');
    assert.equal(normalizeIndianMobile('+91 96807 48057'), '9680748057');
    assert.equal(normalizeIndianMobile('919680748057'), '9680748057');
  });

  it('builds body_1 + button_1 by default (MSG91 OTP sample)', () => {
    const components = buildMsg91WhatsappOtpComponents('944647');
    assert.deepEqual(components.body_1, { type: 'text', value: '944647' });
    assert.deepEqual(components.button_1, {
      subtype: 'url',
      type: 'text',
      value: '944647',
    });
  });

  it('can omit button when requested', () => {
    const components = buildMsg91WhatsappOtpComponents('123456', { includeButton: false });
    assert.ok(components.body_1);
    assert.equal(components.button_1, undefined);
  });

  it('includes WhatsApp button unless omit flag is set', () => {
    const withButton = getMsg91Config({
      msg91WhatsappTemplateId: 'otp_template',
      msg91WhatsappNamespace: 'ns',
      msg91WhatsappIntegratedNumber: '917300069952',
    });
    assert.equal(withButton.whatsappIncludeButton, true);

    const omitted = getMsg91Config({
      msg91WhatsappOmitButton: true,
      msg91WhatsappTemplateId: 'otp_template',
      msg91WhatsappNamespace: 'ns',
      msg91WhatsappIntegratedNumber: '917300069952',
    });
    assert.equal(omitted.whatsappIncludeButton, false);
  });

  it('ignores legacy includeButton=false and still includes button by default', () => {
    const cfg = getMsg91Config({
      msg91WhatsappIncludeButton: false,
      msg91WhatsappTemplateId: 'school_team',
      msg91WhatsappNamespace: '618ac8b3_07ac_4cec_901a_d116111412bc',
      msg91WhatsappIntegratedNumber: '917300069952',
    });
    assert.equal(cfg.whatsappIncludeButton, true);
  });
});

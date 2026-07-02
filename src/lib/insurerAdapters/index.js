import axios from 'axios';

function trimSlash(value) {
  return String(value || '').replace(/\/$/, '');
}

function buildAuthHeaders(config = {}) {
  const authType = String(config.auth_type || config.authType || 'bearer').toLowerCase();
  const headers = {};
  if (authType === 'bearer' && config.api_key) {
    headers.Authorization = `Bearer ${config.api_key}`;
  } else if (authType === 'basic' && config.api_key) {
    headers.Authorization = `Basic ${Buffer.from(`${config.api_key}:${config.api_secret || ''}`).toString('base64')}`;
  } else if (authType === 'x_api_key' && config.api_key) {
    headers['x-api-key'] = config.api_key;
    if (config.api_secret) headers['x-api-secret'] = config.api_secret;
  }
  return headers;
}

function parseRequestConfig(config) {
  const raw = config?.request_config;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function genericApiPurchase({ providerConfig, purchaseOrder, payload }) {
  const requestConfig = parseRequestConfig(providerConfig);
  const endpoint = requestConfig.purchasePath || '/purchase';
  const url = `${trimSlash(providerConfig.base_url)}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  if (!providerConfig.base_url) {
    const err = new Error(`Provider ${providerConfig.provider_code} is missing base_url`);
    err.status = 400;
    throw err;
  }

  const res = await axios.post(url, payload, {
    headers: {
      'Content-Type': 'application/json',
      ...buildAuthHeaders(providerConfig),
    },
    timeout: Number(requestConfig.timeoutMs || 30000),
  });

  return {
    ok: true,
    externalReferenceId:
      res.data?.policyId
      || res.data?.policyNumber
      || res.data?.orderId
      || res.data?.referenceId
      || null,
    policyNumber: res.data?.policyNumber || null,
    summary: res.data?.message || 'Purchase pushed to insurer API',
    response: res.data,
  };
}

async function demoPurchase({ purchaseOrder, payload }) {
  return {
    ok: true,
    externalReferenceId: `DEMO-${purchaseOrder.id.slice(0, 8)}`,
    policyNumber: `RFI-${purchaseOrder.id.slice(0, 6).toUpperCase()}`,
    summary: 'Demo insurer adapter accepted purchase payload',
    response: {
      accepted: true,
      mode: 'demo',
      echoedCustomer: payload?.customer?.email || null,
    },
  };
}

const registry = {
  demo: demoPurchase,
  generic_api: genericApiPurchase,
};

export async function pushPurchaseToInsurer({ providerConfig, purchaseOrder, payload }) {
  const mode = String(providerConfig?.integration_mode || 'generic_api').toLowerCase();
  const adapter = registry[mode];
  if (!adapter) {
    const err = new Error(`No insurer adapter registered for integration mode: ${mode}`);
    err.status = 400;
    throw err;
  }
  return adapter({ providerConfig, purchaseOrder, payload });
}

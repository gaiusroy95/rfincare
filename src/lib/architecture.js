import { getPool, getDatabaseEnvSummary } from '../db/pool.js';
import { getStorageArchitecture, isCloudStorage } from './storage/index.js';

export function getDatabaseArchitecture() {
  return getDatabaseEnvSummary();
}

export function getPlatformArchitecture() {
  return {
    website: 'react-vite',
    mobile: 'expo-react-native',
    admin: 'react-spa',
    api: 'nodejs-express',
    database: getDatabaseArchitecture(),
    storage: getStorageArchitecture(),
    cloudStorage: isCloudStorage(),
  };
}

export async function checkDatabaseConnection() {
  try {
    const pool = getPool();
    await pool.execute('SELECT 1 AS ok');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

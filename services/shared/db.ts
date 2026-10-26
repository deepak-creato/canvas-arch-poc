import { Pool } from 'pg';
import { config } from './config';

export const createPool = () => new Pool({ connectionString: config.databaseUrl, max: 10 });

import dotenv from 'dotenv';
import { resolve } from 'node:path';

// npm workspace scripts run from apps/api; this also loads the root .env used by Docker Compose.
dotenv.config({ path: resolve(process.cwd(), '.env') });
dotenv.config({ path: resolve(process.cwd(), '../../.env') });

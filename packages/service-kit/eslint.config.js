import craftoria from '@craftoria/eslint-config'
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export default [...craftoria];

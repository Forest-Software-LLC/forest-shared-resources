// Aggregate entry point. Consumers may also deep-import a single module:
//   import { ... } from 'forest-shared-resources/verse'
import * as verse from './verse/index';
import * as licenses from './licenses/index';

export { verse, licenses };

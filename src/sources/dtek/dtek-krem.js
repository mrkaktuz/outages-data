import { createDtekAdapter } from './adapter.js';

export default createDtekAdapter({
  id: 'dtek-krem',
  displayName: 'ДТЕК Київські регіональні електромережі',
  region: 'Київська область',
  url: 'https://www.dtek-krem.com.ua/ua/shutdowns',
});

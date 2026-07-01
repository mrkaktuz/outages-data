import { createDtekAdapter } from './adapter.js';

export default createDtekAdapter({
  id: 'dtek-oem',
  displayName: 'ДТЕК Одеські електромережі',
  region: 'Одеська область',
  url: 'https://www.dtek-oem.com.ua/ua/shutdowns',
});

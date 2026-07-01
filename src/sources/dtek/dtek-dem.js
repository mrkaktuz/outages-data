import { createDtekAdapter } from './adapter.js';

export default createDtekAdapter({
  id: 'dtek-dem',
  displayName: 'ДТЕК Донецькі електромережі',
  region: 'Донецька область',
  url: 'https://www.dtek-dem.com.ua/ua/shutdowns',
});

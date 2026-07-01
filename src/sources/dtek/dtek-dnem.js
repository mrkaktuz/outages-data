import { createDtekAdapter } from './adapter.js';

export default createDtekAdapter({
  id: 'dtek-dnem',
  displayName: 'ДТЕК Дніпровські електромережі',
  region: 'Дніпропетровська область',
  url: 'https://www.dtek-dnem.com.ua/ua/shutdowns',
});

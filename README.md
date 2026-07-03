# web — сторінка перегляду графіків

Статична сторінка GitHub Pages (`index.html`, без збірки). Дані читає
клієнтом напряму з гілки [`data`](https://github.com/mrkaktuz/outages-data/tree/data)
і перечитує кожні ~5 хв.

Адреса: https://mrkaktuz.github.io/outages-data/

Локальна розробка: покладіть копії `index.json` та `<source>.json` у `./data/`
поруч з `index.html` і запустіть `python3 -m http.server`.

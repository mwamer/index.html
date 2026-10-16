# Dr Wesam Amer — personal academic website

A nine-page static website presenting the academic profile, research programme, publications, teaching, professional services and public engagement of **Dr Wesam Amer**, a scholar of media, communication and political discourse.

---

## Overview

The site communicates a coherent academic identity, intellectual trajectory and research programme. It is not intended to work as an online CV. It is written for:

- Researchers and academic collaborators
- Universities and research institutions
- Students and supervisees
- Policymakers and international organisations
- Media professionals and journalists
- NGOs and civil society organisations
- Professional and institutional partners

The website has no build step and no server-side code. It is plain HTML, one stylesheet and a small amount of JavaScript.

---

## 📄 Site structure

Every page carries the same navigation header and the same footer. Each page covers one primary topic, and details are cross-linked rather than repeated across pages.

Navigation order, on desktop and in the mobile menu: **Home, About, Research, Publications, Teaching, Academic Profile, News & Engagement, Services, Contact.**

| Page | Purpose |
| --- | --- |
| `index.html` — Home | Hero with the name, role and a short introduction; the four headline statistics; summaries of the four service areas and the four research areas; four selected publications with a link to the full list; a closing invitation to make contact. |
| `about.html` — About | Short biography, research focus, academic biography, intellectual development and research trajectory, international experience, and personal academic perspective. |
| `research.html` — Research | Research philosophy and overview, two research pillars, guiding research questions, the research agenda, theoretical and conceptual frameworks, methodologies, flagship programmes, regional and empirical focus, intellectual trajectory, and related outputs. |
| `publications.html` — Publications | The full publication record in five categories: journal articles; books and edited volumes; book chapters; research reports and policy outputs; theses and dissertations. Entries run in reverse chronological order within each category. |
| `teaching.html` — Teaching and supervision | Teaching experience, areas of teaching expertise, postgraduate supervision, and examination. |
| `academic-profile.html` — Academic profile | Academic appointments and institutional affiliations, education and academic qualifications, fellowships, research funding and awards, and an academic career timeline. |
| `news-engagement.html` — News and engagement | Presentations, talks and events; policy engagement and knowledge exchange; academic networks and service; peer review and advisory service. Entries run in reverse chronological order. |
| `services.html` — Services | The four areas of academic and professional expertise, each with an explanation, the audience it serves, and the activities it covers. |
| `contact.html` — Contact | The contact email, a note about arranging meetings, and links to the academic profile pages. |

### Research focus areas

The site presents four research areas on the home page and develops them on the Research page:

- Hypermedia warfare and conflict communication
- AI-mediated communication
- Platform governance and visibility
- Higher education in conflict zones

---

## 🎨 Design

### Colour palette

The palette is defined as CSS custom properties in `styles.css`. Tailwind's default utility colours are re-pointed at these tokens, so the palette stays consistent wherever Tailwind classes are used.

| Token | Value | Role |
| --- | --- | --- |
| `--ivory` | `#F7F5F0` | Page background |
| `--navy` | `#24384A` | Headings and strong text |
| `--slate` | `#53616B` | Body text |
| `--terracotta` | `#A66B50` | Accent colour for links and labels |
| `--terracotta-dark` | `#8C5640` | Accent hover states and emphasis |
| `--stone` | `#DED9D0` | Borders and dividers |
| `--white` | `#FFFFFF` | Surfaces and cards |

### Typography

- **Headings:** `Georgia, 'Times New Roman', serif`.
- **Body:** the system sans-serif stack, beginning with `-apple-system` and `BlinkMacSystemFont`.

### Layout

Serif headings carry the academic character, and sans-serif body text keeps long passages readable. The design uses generous whitespace, subtle dividers, and restrained use of cards, shadows and icons. Headings scale with viewport width through `clamp()`.

Breakpoints:

- The navigation collapses to a menu button below 1024px.
- The homepage statistics grid shows four columns above 1000px, two columns from 601 to 1000px, and one column at 600px and below.
- Service and research area grids collapse to a single column below 900px.

### Accessibility

- High-contrast palette, with a stronger contrast option through `prefers-contrast`.
- Semantic HTML with one `h1` per page and a logical heading order.
- Visible focus outlines through `:focus-visible` for keyboard users.
- Animation and transition effects honour `prefers-reduced-motion`.
- Print styles for pages that users need to print or save as PDF.

---

## 🛠️ Technology and architecture

| Layer | Implementation |
| --- | --- |
| Markup | HTML5 |
| Styling | Tailwind CSS through the CDN, plus `styles.css` for all custom styling |
| Behaviour | A short inline script at the end of each page, which opens and closes the mobile menu |
| Build | None. No dependencies, no bundler, no package manager |

### Project files

```
├── index.html                 # Home
├── about.html                 # About
├── research.html              # Research
├── publications.html          # Publications
├── teaching.html              # Teaching and supervision
├── academic-profile.html      # Academic profile
├── news-engagement.html       # News and engagement
├── services.html              # Services
├── contact.html               # Contact
├── engagement-*.html          # One page per news entry that has a full record
├── .panel-state.json          # What the panel has published, and what it deleted
├── styles.css                 # Palette tokens, component styles, responsive rules, print and accessibility styles
├── CNAME                      # Custom domain for GitHub Pages: wesamamer.com
├── README.md                  # This file
├── admin/                     # The editing panel (see below)
├── worker/                    # The API the panel writes through (see worker/README.md)
├── tools/                     # The publishing guard, and the tool that records a hand edit
├── hooks/pre-push             # Runs the guard on your machine before a push
└── .github/workflows/         # The publishing guard on every push, and SLSA provenance on a release
```

Each page carries its own copy of the navigation header and the footer, and its own inline menu script. There is no shared template, so a change to navigation or the footer has to be applied to all nine pages.

The pages show designed empty frames until approved photographs are supplied, so the site loads no images of its own.

---

## 🖊️ The admin panel

News entries can be edited in a browser at [wesamamer.com/admin/](https://wesamamer.com/admin/) — signing in through Cloudflare Access, editing, and pressing **Save and publish**. Two people can use it: the owner and the editors the owner adds.

Each save is published as **one commit**. The news page, the record pages it links to, the photographs they use, and `.panel-state.json` all land together or not at all, so the site is never readable in a half-changed state. If the site moved while the panel was open, the save is refused rather than allowed to overwrite the other person's work — and the panel keeps what you were writing.

**Deleting an entry is permanent.** Marking an entry for deletion removes its card, deletes its record page if it has one, and removes any photograph no other page uses. An ordinary save can be undone with one click; a deletion cannot.

The panel is three files, with no build step:

| File | Role |
| --- | --- |
| `admin/index.html` | the page itself, and the glue |
| `admin/panel.js` | the pure logic: parsing and rendering a page, deciding what a save holds, what an undo may restore |
| `admin/api-worker.js` | the client for the API |
| `admin/panel.test.mjs` | the pure logic, checked directly |
| `admin/page.test.mjs` | the page's own glue, run against a stand-in browser so it is exercised rather than merely read |

### Who may publish, and where that is kept

The list of editors lives in a Cloudflare D1 database, not in the code. Only the owner may change it, from **Manage editors** in the panel. A new editor starts **pending**: they can sign in and look, but cannot publish until the owner activates them.

Cloudflare Access holds a second copy of who may sign in, and the Worker keeps it in step with the registry after every editor change. Both copies matter: Access is the gate, the registry is the authority.

---

## 🛡️ The publishing guard

A clone that is behind can restore an article that was deliberately deleted, and a merge does it quietly. The guard compares the site against `.panel-state.json` on every push and fails the build when a page no longer matches what the panel published.

It **reports and never rewrites**. A deliberate hand edit is legitimate; recording it is what makes it so:

```bash
node tools/content-state.mjs    # record what you have just edited
git add -A && git commit && git push
```

The same check runs in two places — `.github/workflows/content-guard.yml` on every push, and `hooks/pre-push` on your machine if you enable it once per clone:

```bash
git config core.hooksPath hooks
```

---

## 🚀 Local development

1. Clone the repository:

   ```bash
   git clone https://github.com/mwamer/index.html.git
   cd index.html
   ```

2. Serve the folder and open it in a browser:

   ```bash
   python3 -m http.server 8000
   ```

   Then visit `http://localhost:8000`. Opening `index.html` directly from the file system also works, but a local server tests relative links more accurately.

3. Edit the file you need, then reload the browser. No build or compile step is required.

---

## 🌐 Publishing

- **Live site:** [wesamamer.com](https://wesamamer.com/)
- **Repository:** [github.com/mwamer/index.html](https://github.com/mwamer/index.html)
- **Hosting:** GitHub Pages, publishing the `main` branch root folder
- **Custom domain:** `wesamamer.com`, configured through the `CNAME` file in the repository root

The home page is at `https://wesamamer.com/`. Every other page sits directly beside it, for example `https://wesamamer.com/about.html`. The `www.wesamamer.com` address redirects to `wesamamer.com`, and `mwamer.github.io/index.html` redirects to the custom domain as well.

GitHub Pages republishes the site on every push to `main`, so review changes locally before you push. The workflow in `.github/workflows/` generates SLSA provenance when you create a release, and does not run on a push.

---

## 🔧 Maintenance

- **Publications:** edit `publications.html`. Keep entries in reverse chronological order within their category, and add a publisher link only after you verify the record against the publisher.
- **Academic profile:** edit `academic-profile.html` for appointments, qualifications, fellowships, funding, awards and timeline entries.
- **News and engagement:** edit `news-engagement.html`, keeping entries in reverse chronological order.
- **Styling:** edit `styles.css`. Change the palette in one place, at the `:root` block, and the whole site follows.
- **A new page:** copy an existing page, then update the navigation and footer in all nine pages, because no shared template exists.
- **Photographs:** add an image and replace the designed empty frame on the page that needs it. Never repeat one portrait across pages.
- **Testing:** check desktop, tablet and mobile widths before you push.

### The panel and the guard

- **A news entry:** use the [admin panel](https://wesamamer.com/admin/) rather than editing `news-engagement.html` by hand. The panel keeps the news page, the record pages, the photographs and `.panel-state.json` together.
- **A hand edit to the published content:** run `node tools/content-state.mjs` and commit the updated state file in the same push, or the guard stops the push.
- **The panel or the API:** run the tests before changing either.

  ```bash
  node --test admin/ tools/ worker/    # 145 checks, no network, no credentials
  ```

- **The guard itself:** `tools/content-guard.mjs` decides what counts as a legitimate change. `tools/publishing-flow.test.mjs` drives it on a throwaway repository, so a change to the panel's commit model shows up there.

---

## 📌 Outstanding items

- **CV PDF.** The CV is not published. The download button on the home page and the download block on the Academic Profile page stay disabled until the approved PDF is supplied. Do not add a link until then.
- **Photographs.** Page photographs are pending, so the pages show designed empty frames.
- **Unverified links.** Publication records without a verified publisher link are left unlinked rather than guessed.

---

## ✅ Browser support

Chrome and Edge (latest), Firefox (latest), Safari (latest), and the mobile browsers on iOS and Android.

---

## 📝 License

This project is personal. Copyright © Dr Mohammedwesam Amer. All rights reserved.

---

## 📞 Contact

Email: **wesaam.amer@gmail.com**

Academic profiles:

- [ORCID](https://orcid.org/0000-0002-8796-9097)
- [Google Scholar](https://scholar.google.com/citations?user=CNgZsPQAAAAJ&hl=en)
- [LinkedIn](https://www.linkedin.com/in/dr-mohammedwesam-amer-b1b40932/)
- [University of Cambridge](https://research.sociology.cam.ac.uk/profile/dr-wesam-amer)

---

**Documentation date:** October 12, 2026

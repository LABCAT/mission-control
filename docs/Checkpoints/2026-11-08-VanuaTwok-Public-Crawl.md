# VanuaTwok public crawl r1 — page-by-page inventory

**Target:** https://vanuatuwok.vu/ (canonical). WordPress + JobRoller 1.9.8 behind Cloudflare. Crawled 2026-11-08 UTC, unauthenticated, read-only. No site or repository changes.

**Method:** robots.txt -> sitemap_index.xml -> 12 child sitemaps; navigation and internal links; RSS feeds; `?p=` shortlinks; job search and filters; pagination. Every unique URL was requested (HEAD for CV/attachment routes; GET for normal HTML; GET status-only for the CV listing, one CV detail sample and all CV taxonomy routes, while `/resumes/page/2/` and the remaining CV detail GETs were not requested). A transient Cloudflare 503/retry-after burst occurred under concurrency and was retried sequentially; final statuses are below.

## 1. Sitemap index (12 child files)

| Child sitemap | `<loc>` count | Unique | Notes |
|---|---:|---:|---|
| `page-sitemap.xml` | 33 | 32 | contains /jobs/ duplicate, PDF, xmlrpc |
| `attachment-sitemap.xml` | 147 | 147 | attachment pages (images/docs/CV files) |
| `job_listing-sitemap.xml` | 29 | 29 | includes /jobs/ archive |
| `resume-sitemap.xml` | 201 | 201 | 200 detail pages + /resumes/ listing |
| `job_cat-sitemap.xml` | 10 | 10 | job categories |
| `job_type-sitemap.xml` | 8 | 8 | job types |
| `job_salary-sitemap.xml` | 5 | 5 | salary bands |
| `resume_category-sitemap.xml` | 39 | 39 | CV categories |
| `resume_job_type-sitemap.xml` | 4 | 4 | CV job types |
| `resume_specialities-sitemap.xml` | 80 | 80 | CV specialities |
| `resume_groups-sitemap.xml` | 16 | 16 | CV groups |
| `resume_languages-sitemap.xml` | 37 | 37 | CV languages |

Total: **609 `<loc>` entries, 608 unique** (the only cross-sitemap duplicate is `/jobs/`, in both page and job_listing sitemaps).

## 2. Crawl totals

- 608 unique sitemap URLs + 163 non-sitemap URLs discovered by navigation, internal links, feeds, shortlinks, search/pagination = **771 crawl URLs** (excluding CSS/JS/images and `wp-json`).
- 554 public HTML page URLs: **176 non-CV HTML** + **378 CV-module HTML**.
- 147 attachment pages, 62 RSS feeds, 6 PDF files, 2 XML-RPC/REST endpoints.
- 50 `?p=` shortlink URLs (301 to canonical pages; mapped in section 8).
- 28 live job-detail pages are linked from organisation pages but are **absent from the job sitemap** — a real sitemap gap.

## 3. Public HTML pages (non-CV)

Shared header/footer on every page: brand/nav (Jobs, Volunteering, For Employers, Organisations, About YCV), Login/Register, Submit a Job, search form, footer links. Shared templates are annotated once; each URL is listed individually.

### 3.1 Core, content and utility pages

- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu — FIND A JOB IN VANUATU
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml,link — https://vanuatuwok.vu/ — FIND A JOB IN VANUATU
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/?p=23445 — Organisations
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/?p=38 — For Employers
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/?p=3983 — About us
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/?p=5 — Blog &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/?p=61 — Volunteering &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/?p=655 — Contact us
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/?p=791 — Resumes restricted
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/?p=9 — Job Date Archive &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/about-us — About us
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml,link — https://vanuatuwok.vu/about-us/ — About us
- HEAD 200; GET 200; application/pdf; src=link — https://vanuatuwok.vu/app/uploads/2021/05/A5-PRINT-VERSION-Vanuatu-Wok-booklet-PDF-version-1.pdf
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml,link — https://vanuatuwok.vu/blog/ — Blog &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/contact — Contact us
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml — https://vanuatuwok.vu/contact-2/ — Contact
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml,link — https://vanuatuwok.vu/contact/ — Contact us
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/employer/ — For Employers
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml,link — https://vanuatuwok.vu/employers/ — For Employers
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml — https://vanuatuwok.vu/home-2/ — Home &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml,link — https://vanuatuwok.vu/job-date-archive/ — Job Date Archive &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/job-date-archive/?time=lastweek&jobs_by_date=1 — Job Date Archive &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/job-date-archive/?time=month&jobs_by_date=1 — Job Date Archive &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/job-date-archive/?time=today&jobs_by_date=1 — Job Date Archive &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/job-date-archive/?time=week&jobs_by_date=1 — Job Date Archive &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml — https://vanuatuwok.vu/land-law-reforms/ — LAND LAW REFORMS
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml — https://vanuatuwok.vu/organisation-competition/ — Organisation Competition
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml,link — https://vanuatuwok.vu/organisations/ — Organisations
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml — https://vanuatuwok.vu/sample-page/ — Sample Page
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml — https://vanuatuwok.vu/terms-conditions/ — Terms &#038; Conditions
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml,link — https://vanuatuwok.vu/volunteer-jobs/ — Volunteering &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/wp/jobs/ — Jobs Archive &#187; Vanuatu Wok
- HEAD 200; GET 200; text/xml; charset=UTF-8; src=link — https://vanuatuwok.vu/wp/rss-feed/
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/wp/wp-login.php — Login/Register
- HEAD 405; GET 405; text/plain;charset=UTF-8; src=link — https://vanuatuwok.vu/wp/xmlrpc.php
- HEAD 200; GET 200; text/xml; charset=UTF-8; src=link — https://vanuatuwok.vu/wp/xmlrpc.php?rsd

### 3.2 Job archive and pagination

Shared: search form (keyword + location), job-type checkbox filter, category/salary links, 20 jobs per page.

- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/jobs — Jobs Archive &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/ — Jobs Archive &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/jobs/page/1/ — Jobs Archive &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/jobs/page/2/ — Jobs Archive &#187; Page 2 of 2 &#187; Vanuatu Wok

### 3.3 Job detail pages (56)

Shared template: title/job type, organisation, location, salary, category, description, Apply Online form (name, email, message, optional CV and cover-letter upload, anti-spam question), Print Job (`window.print()`), AddThis share, organisation/category/salary links. 28 are absent from the sitemap and were found via organisation pages/login redirects.

- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/administration-manager-4/ — Full-Time ADMINISTRATION MANAGER
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/assistant-accountant-7/ — ASSISTANT ACCOUNTANT &#187; Vanuatu Wok
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/cleaner-6/ — CLEANER &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/disaster-ready-project-manager-3/ — Full-Time DISASTER READY PROJECT MANAGER
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/employe-administratif/ — EMPLOYE ADMINISTRATIF &#187; Vanuatu Wok
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/enseignant-tuteur/ — ENSEIGNANT-TUTEUR &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/enumerator/ — Voluntary Enumerator
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/executive-chef-16/ — Full-Time EXECUTIVE CHEF
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/experienced-chef-bar-kitchen-reception-office/ — Full-Time EXPERIENCED CHEF/ BAR/ KITCHEN / RECEPTION &#038; OFFICE
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/experienced-resort-staff/ — Full-Time EXPERIENCED RESORT STAFF
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/finance-administration-officer-vanuatu-value-chain-programme-vavac/ — FINANCE &amp; ADMINISTRATION OFFICER- VANUATU VALUE CHAIN PROGRAMME (VAVAC) &#187; Vanuatu Wok
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/food-and-beverage-manager/ — FOOD AND BEVERAGE MANAGER &#187; Vanuatu Wok
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/general-manager-5/ — GENERAL MANAGER &#187; Vanuatu Wok
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/guest-relations/ — GUEST RELATIONS &#187; Vanuatu Wok
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/heavy-mechanic/ — HEAVY MECHANIC &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/housekeeping-supervisor-3/ — Full-Time HOUSEKEEPING SUPERVISOR
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/insurance-consultant-tower-insurance/ — INSURANCE CONSULTANT - TOWER INSURANCE &#187; Vanuatu Wok
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/job-opportunities-6/ — JOB OPPORTUNITIES &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/job-vacancy-junior-photocopier-technician/ — Full-Time JOB VACANCY &#8211; JUNIOR PHOTOCOPIER TECHNICIAN
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/labour-construction-works-only-for-three-3-rainwater-harvesting-systems-on-paama-island-at-the-following-sites-liro-tevali-tevaliaot/ — Full-Time LABOUR CONSTRUCTION WORKS ONLY FOR THREE (3) RAINWATER HARVESTING SYSTEMS ON PAAMA ISLAND, AT THE FOLLOWING SITES: LIRO TEVALI TEVALIAOT
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/lecturer-in-accounting/ — Contract LECTURER IN ACCOUNTING
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/light-automotive-technician/ — LIGHT AUTOMOTIVE TECHNICIAN &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/logistics-assistant-2/ — Full-Time LOGISTICS ASSISTANT
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/mason%ef%bc%88bricklayer-brickmason%ef%bc%89/ — Contract MASON（BRICKLAYER / BRICKMASON）
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/mechanic-10/ — Full-Time MECHANIC
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/merchandiser-2/ — MERCHANDISER &#187; Vanuatu Wok
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/office-cleaner-5/ — OFFICE CLEANER &#187; Vanuatu Wok
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/operations-manager-16/ — OPERATIONS MANAGER &#187; Vanuatu Wok
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/program-support-officer/ — PROGRAM SUPPORT OFFICER &#187; Vanuatu Wok
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/project-officer-2/ — PROJECT OFFICER &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/provision-of-dwssp-training-and-reporting-for-sanma-province/ — Contract PROVISION OF DWSSP TRAINING AND REPORTING FOR SANMA PROVINCE
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/provision-of-dwssp-training-and-reporting-for-tafea-province/ — Contract PROVISION OF DWSSP TRAINING AND REPORTING FOR TAFEA PROVINCE
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/provision-of-technical-assessment-design-and-cost-estimation-of-five-earthquake-affected-community-water-supply-systems-in-efate-vanuatu/ — Full-Time PROVISION OF TECHNICAL ASSESSMENT, DESIGN AND COST ESTIMATION OF FIVE EARTHQUAKE-AFFECTED COMMUNITY WATER SUPPLY SYSTEMS IN EFATE, VANUATU
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/qualified-electrician-5/ — QUALIFIED ELECTRICIAN &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/readvertised-request-for-expressions-of-interest-reoi-esmasp-conveyancing-lawyer/ — Contract ( READVERTISED ) REQUEST FOR EXPRESSIONS OF INTEREST (REOI) &#8211; ESMASP CONVEYANCING LAWYER
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/readvertised-request-for-expressions-of-interest-reoi-real-estate-agent-firm/ — Contract ( READVERTISED) REQUEST FOR EXPRESSIONS OF INTEREST (REOI) &#8211; REAL ESTATE AGENT/ FIRM
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/receptionist-2/ — RECEPTIONIST &#187; Vanuatu Wok
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/registered-nurse/ — REGISTERED NURSE &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/request-for-expressions-of-interest-reoi-change-management-specialist-pecialist/ — Contract REQUEST FOR EXPRESSIONS OF INTEREST (REOI) &#8211; CHANGE MANAGEMENT SPECIALIST pecialist
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/request-for-quotation-development-of-a-revised-vanuatu-national-ngo-policy-towards-a-strategic-partnership-framework-for-localised-development-2026-2020/ — Contract REQUEST FOR QUOTATION &#8211; DEVELOPMENT OF A REVISED VANUATU NATIONAL NGO POLICY: TOWARDS A STRATEGIC PARTNERSHIP FRAMEWORK FOR LOCALISED DEVELOPMENT (2026-2020)
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/request-for-quotation-expert-concultant-to-develop-an-important-substitution-srategy/ — Contract REQUEST FOR QUOTATION &#8211; EXPERT CONSULTANT TO DEVELOP AN IMPORT SUBSTITUTION SRATEGY
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/responsable-huilerie-oil-mill-manager/ — RESPONSABLE HUILERIE/ OIL MILL MANAGER &#187; Vanuatu Wok
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/retail-assistant/ — RETAIL ASSISTANT &#187; Vanuatu Wok
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/sales-person-2/ — SALES PERSON &#187; Vanuatu Wok
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/senior-accountant-auditor-2/ — MANAGER ACCOUNTING AND AUDIT &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/senior-analyst-parts-supervisor-5/ — Full-Time SENIOR ANALYST PARTS SUPERVISOR
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/senior-fleet-maintenance-officer/ — SENIOR FLEET MAINTENANCE OFFICER &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/senior-lecturer-in-accounting/ — Contract SENIOR LECTURER IN ACCOUNTING
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/skills-adviser-vanuatu-multiple-positions/ — Contract SKILLS ADVISER – VANUATU (MULTIPLE POSITIONS)
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/teachers-2/ — Full-Time TEACHERS
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/technical-records-and-stores/ — TECHNICAL RECORDS AND STORES &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/trainee/ — Full-Time TRAINEE
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/vanuatu-livelihoods-project-manager/ — VANUATU LIVELIHOODS PROJECT MANAGER &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/vendeur-preparateur-livreur-6/ — Full-Time VENDEUR, PREPARATEUR &#038; LIVREUR
- GET 200 text/html; src=link — https://vanuatuwok.vu/jobs/waiters-bartenders-cashiers/ — READVERTISEMENT OF WAITERS, BARTENDERS, CASHIERS (NI-VANUATU APPLICANTS ONLY) &#187; Vanuatu Wok
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_listing.xml,link — https://vanuatuwok.vu/jobs/welder-2/ — Full-Time WELDER

### 3.4 Organisation profile pages (29)

Shared template: organisation name/description, contact/email (Cloudflare-obfuscated), job list, organisation feed, login redirect for apply. Found from /organisations/.

- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/83-islands-distillery/ — 83 Islands Distillery
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/agence-universitaire-de-la-francophonie/ — Agence Universitaire de la francophonie
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/ajc/ — AJC
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/bred-bank-(vanuatu)-limited/ — BRED Bank (Vanuatu) Limited
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/carpenter-motors-(vanuatu)-limited/ — CARPENTER MOTORS (VANUATU) LIMITED
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/entani-company/ — Entani Company
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/giz/ — GIZ
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/hseq-vanuatu/ — HSEQ Vanuatu
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/iririki-island-resort-and-spa/ — Iririki Island Resort and Spa
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/law-partners/ — Law Partners
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/link-personnel-services/ — Link Personnel Services
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/nasama-resort/ — NASAMA RESORT
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/nasituan/ — NasiTuan
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/novo-dental/ — Novo Dental
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/oxfam/ — Oxfam
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/pacific-energy/ — Pacific Energy
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/spycon-ltd/ — Spycon Ltd
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/tamanu-on-the-beach/ — Tamanu on the beach
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/teouma-christian-academy/ — Teouma Christian Academy
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/titan-fx/ — Titan FX
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/tower-insurance/ — Tower Insurance
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/unelco-engie/ — UNELCO ENGIE
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/vanuatu-air-charters-ltd/ — Vanuatu Air Charters Ltd
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/vanuatu-brewing-ltd/ — VANUATU BREWING LTD
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/vanuatu-helicopters/ — Vanuatu Helicopters
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/vanuatu-qualifications-authority/ — Vanuatu Qualifications Authority
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/vate-electrics/ — VATE ELECTRICS
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/wanfuteng-bank/ — WANFUTENG BANK
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/organisation/world-car-rentals-vanuatu/ — World Car Rentals Vanuatu

### 3.5 Job category/type/salary filters (23)

Shared template: filtered job archive with keyword/location search and job-type checkboxes. All return 200.

- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_cat.xml,link — https://vanuatuwok.vu/job-category/automotive/ — Automotive Job(s)
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_cat.xml,link — https://vanuatuwok.vu/job-category/construction-roading/ — Construction &amp; roading Job(s)
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_cat.xml,link — https://vanuatuwok.vu/job-category/education/ — Education Job(s)
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_cat.xml,link — https://vanuatuwok.vu/job-category/government-council/ — Government &amp; council Job(s)
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_cat.xml,link — https://vanuatuwok.vu/job-category/hospitality-tourism/ — Hospitality &amp; Tourism Job(s)
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_cat.xml,link — https://vanuatuwok.vu/job-category/it/ — IT Job(s)
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_cat.xml,link — https://vanuatuwok.vu/job-category/non-government-organisation-ngo/ — Non Government Organisation (NGO) Job(s)
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_cat.xml,link — https://vanuatuwok.vu/job-category/other/ — Other Job(s)
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_cat.xml,link — https://vanuatuwok.vu/job-category/trades-services/ — Trades &amp; Services Job(s)
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_cat.xml,link — https://vanuatuwok.vu/job-category/transport-logistics/ — Transport &amp; Logistics Job(s)
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_salary.xml,link — https://vanuatuwok.vu/job-salary/0-100000/ — Jobs with a salary of Vt 0 &#8211; 1,000,000
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_salary.xml,link — https://vanuatuwok.vu/job-salary/4000000-or-more/ — Jobs with a salary of Vt 4,000,000 or more
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_salary.xml,link — https://vanuatuwok.vu/job-salary/6000000-or-more/ — Jobs with a salary of Vt 6,000,000 or more
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_salary.xml,link — https://vanuatuwok.vu/job-salary/according-to-experience-and-qualification/ — Jobs with a salary of Vt According to experience and qualification
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_salary.xml,link — https://vanuatuwok.vu/job-salary/not-stated/ — Jobs with a salary of Vt Not stated
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_type.xml,link — https://vanuatuwok.vu/job-type/casual/ — Casual Job(s)
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_type.xml,link — https://vanuatuwok.vu/job-type/contract/ — Contract Job(s)
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_type.xml,link — https://vanuatuwok.vu/job-type/full-time/ — Full-Time Job(s)
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_type.xml,link — https://vanuatuwok.vu/job-type/not-stated/ — Not Stated Job(s)
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_type.xml,link — https://vanuatuwok.vu/job-type/part-time/ — Part-Time Job(s)
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_type.xml — https://vanuatuwok.vu/job-type/voluntary/ — Voluntary Job(s)
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_type.xml — https://vanuatuwok.vu/job-type/voluntary/board-position/ — Board position Job(s)
- HEAD 200; GET 200; text/html; charset=UTF-8; src=job_type.xml — https://vanuatuwok.vu/job-type/voluntary/internship-voluntary/ — Internship Job(s)

### 3.6 Account, auth and form pages (31)

Shared login/register template (job-seeker/employer roles). Protected pages 302 to /login/?redirect_to=…; public forms listed with their fields.

- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml — https://vanuatuwok.vu/confirm/ — Confirmation Page
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml — https://vanuatuwok.vu/dashboard/ — Login/Register
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml — https://vanuatuwok.vu/edit-job/ — Login/Register
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml — https://vanuatuwok.vu/edit-resume/ — Login/Register
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml — https://vanuatuwok.vu/job-email-text/ — Job email text
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/login — Login/Register
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml,link — https://vanuatuwok.vu/login/ — Login/Register
- HEAD 404; GET 404; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/login/&role=job_seeker
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/login/?redirect_to=https%3A%2F%2Fvanuatuwok.vu%2Fabout-us%2F&role=job_seeker — Login/Register
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/login/?redirect_to=https%3A%2F%2Fvanuatuwok.vu%2Fcontact%2F&role=job_seeker — Login/Register
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/login/?redirect_to=https%3A%2F%2Fvanuatuwok.vu%2Femployers%2F&role=job_seeker — Login/Register
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/login/?redirect_to=https%3A%2F%2Fvanuatuwok.vu%2Fjob-date-archive%2F&role=job_seeker — Login/Register
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/login/?redirect_to=https%3A%2F%2Fvanuatuwok.vu%2Fjobs%2Fjob-vacancy-junior-photocopier-technician%2F&role=job_seeker — Login/Register
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/login/?redirect_to=https%3A%2F%2Fvanuatuwok.vu%2Fjobs%2Fskills-adviser-vanuatu-multiple-positions%2F&role=job_seeker — Login/Register
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/login/?redirect_to=https%3A%2F%2Fvanuatuwok.vu%2Fno-resumes%2F&role=job_seeker — Login/Register
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/login/?redirect_to=%2Fresumes%2F%3Credacted%3E%2F — Login/Register
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/login/?redirect_to=https%3A%2F%2Fvanuatuwok.vu%2Fvolunteer-jobs%2F&role=job_seeker — Login/Register
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/my-profile — Login/Register
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml — https://vanuatuwok.vu/my-profile/ — Login/Register
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml,link — https://vanuatuwok.vu/no-resumes/ — Resumes restricted
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml,link — https://vanuatuwok.vu/password-recovery/ — Password Recovery
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml,link — https://vanuatuwok.vu/password-reset/ — Password Recovery
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml,link — https://vanuatuwok.vu/purchase-job-pack/ — Login/Register
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml — https://vanuatuwok.vu/purchase-resume-subscription/ — FIND A JOB IN VANUATU
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/register — Login/Register
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml — https://vanuatuwok.vu/register/ — Login/Register
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml — https://vanuatuwok.vu/resend-confirmation/ — Resend Confirmation Email
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/sign-up — Sign-up to our Email
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml,link — https://vanuatuwok.vu/sign-up/ — Sign-up to our Email
- HEAD 200; GET 200; text/html; charset=UTF-8; src=link — https://vanuatuwok.vu/submit — Login/Register
- HEAD 200; GET 200; text/html; charset=UTF-8; src=page.xml,link — https://vanuatuwok.vu/submit/ — Login/Register

## 4. CV / resume module

**Key finding:** all reachable discovered CV routes advertise HTTP 200 on HEAD; the only non-200s are two sitemap-published taxonomy URLs that return 404 on both HEAD and GET. On GET, **HTTP 500** (`text/html`, WordPress critical-error page) was observed only on `/resumes/`, one sampled CV detail page (`/resumes/<redacted>/`) and all 174 reachable CV taxonomy routes. `/resumes/page/2/` and the remaining 199 CV detail pages were not GET-requested (stop rule). The sitemap publishes 201 resume URLs and all 200 testable detail HEADs return 200. No CV body was inspected, retained, or reproduced. The only CV route that returned content was `/resumes/feed/` (RSS, 200, 20 `<item>` entries); bodies were not inspected or reproduced and further CV body requests were stopped.

### 4.1 CV listing / auxiliary

- https://vanuatuwok.vu/resumes/ — HEAD 200 text/html; charset=UTF-8; GET 500 text/html — listing
- https://vanuatuwok.vu/resumes/page/2/ — HEAD 200 text/html; charset=UTF-8; GET not requested (stop rule) — pagination
- https://vanuatuwok.vu/resumes/feed/ — HEAD 200 application/rss+xml; charset=UTF-8; GET 200 application/rss+xml, 20 items — RSS feed, canonical /resumes/

### 4.2 CV detail URLs (200; HEAD 200 text/html; GET not requested except one sampled 500)

The sitemap publishes 200 candidate CV detail URLs; individual paths are omitted from this checkpoint to avoid retaining profile identifiers.

### 4.3 CV taxonomy/filter URLs (176; HEAD 200 except two 404; GET 500 except the same two 404)

The 176 discovered CV taxonomy routes comprised 174 reachable routes (HEAD 200; GET 500) and two published sitemap routes returning 404 for both methods. Individual taxonomy slugs are omitted because some contain profile-derived language or skills.

## 5. Attachment URLs (147; HEAD 200 text/html)

All are WordPress attachment pages, not raw files. 82 sit under `/resumes/` and are CV-related; their individual paths and filename slugs are omitted to avoid retaining profile identifiers or names. One staff-image path is also omitted by name. No attachment body was requested or inspected.

- https://vanuatuwok.vu/about-us/5b08ddf5d15ed-image/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/img_5612/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-31-07-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-31-11-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-31-29-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-37-23-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-37-29-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-37-36-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-37-39-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-37-45-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-37-49-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-37-59-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-38-04-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-38-10-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-38-17-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-38-21-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-38-27-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-38-35-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-38-38-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-38-44-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-38-51-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-38-58-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-39-04-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-39-08-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-39-14-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/screen-shot-2018-06-08-at-1-42-35-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/about-us/ycv-12/ — HEAD 200 text/html
- https://vanuatuwok.vu/employers/08245b/ — HEAD 200 text/html
- https://vanuatuwok.vu/employers/a5-print-version-vanuatu-wok-booklet-pdf-version-1/ — HEAD 200 text/html
- https://vanuatuwok.vu/employers/job-pack-pricings/ — HEAD 200 text/html
- https://vanuatuwok.vu/employers/list-job-vacancy-now/ — HEAD 200 text/html
- https://vanuatuwok.vu/employers/screen-shot-2018-02-09-at-12-00-27-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/employers/screen-shot-2021-05-31-at-7-12-57-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/employers/screen-shot-2021-05-31-at-7-48-44-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/employers/screen-shot-2021-05-31-at-7-48-47-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/employers/vanuatu-wok-powered-by-youth-challenge-vanuatu/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/administration-manager-4/attachment/141652/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/administration-manager-4/attachment/141654/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/enumerator/attachment/141711/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/enumerator/attachment/141713/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/enumerator/unv-logo-2/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/experienced-chef-bar-kitchen-reception-office/attachment/140041/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/experienced-chef-bar-kitchen-reception-office/attachment/140042/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/experienced-resort-staff/attachment/141438/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/experienced-resort-staff/erakor-island-resort-and-spa-logo/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/logistics-assistant-2/attachment/141517/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/logistics-assistant-2/attachment/141518/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/logistics-assistant-2/attachment/141520/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/logistics-assistant-2/attachment/141523/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/readvertised-request-for-expressions-of-interest-reoi-esmasp-conveyancing-lawyer/reoi-esmasp-conveyancing-lawyer-readvertised/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/readvertised-request-for-expressions-of-interest-reoi-real-estate-agent-firm/reoi-esmasp-real-estate-agent-readvertised/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/request-for-expressions-of-interest-reoi-change-management-specialist-pecialist/reoi-change-mangement-specialist/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/skills-adviser-vanuatu-multiple-positions/attachment/141552/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/skills-adviser-vanuatu-multiple-positions/dt-global-logo-v2-18/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/teachers-2/attachment/141677/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/teachers-2/attachment/141678/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/teachers-2/primary-teachers-job-advertisement-2/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/trainee/attachment/141526/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/trainee/attachment/141527/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/welder-2/attachment/141642/ — HEAD 200 text/html
- https://vanuatuwok.vu/jobs/welder-2/iiss-logo/ — HEAD 200 text/html
- https://vanuatuwok.vu/land-law-reforms/press-release-lands-reforms-_compressed/ — HEAD 200 text/html
- https://vanuatuwok.vu/organisation-competition/screen-shot-2020-06-19-at-4-08-42-pm/ — HEAD 200 text/html
- https://vanuatuwok.vu/sign-up/want52650-19fslk1499512787/ — HEAD 200 text/html
- 82 CV-related attachment URLs were verified by HEAD; the individual paths and filename slugs are omitted, along with one staff-image path.


## 6. RSS feeds (62)

All returned 200. Site/job feeds have 20 items unless noted; 29 are per-organisation feeds, 23 per-taxonomy feeds.

- https://vanuatuwok.vu/feed/ — GET 200 application/rss+xml; charset=UTF-8; 20 items
- https://vanuatuwok.vu/feed/?post_type=job_listing — GET 200 application/rss+xml; charset=UTF-8; 20 items
- https://vanuatuwok.vu/feed/?rss_featured=1 — GET 200 application/rss+xml; charset=UTF-8; 3 items
- https://vanuatuwok.vu/feed/?rss_featured=1&rss_job_cat=98 — GET 200 application/rss+xml; charset=UTF-8; 2 items
- https://vanuatuwok.vu/job-category/automotive/feed/ — GET 200 application/rss+xml; charset=UTF-8; 1 items
- https://vanuatuwok.vu/job-category/construction-roading/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/job-category/education/feed/ — GET 200 application/rss+xml; charset=UTF-8; 3 items
- https://vanuatuwok.vu/job-category/government-council/feed/ — GET 200 application/rss+xml; charset=UTF-8; 8 items
- https://vanuatuwok.vu/job-category/hospitality-tourism/feed/ — GET 200 application/rss+xml; charset=UTF-8; 4 items
- https://vanuatuwok.vu/job-category/it/feed/ — GET 200 application/rss+xml; charset=UTF-8; 1 items
- https://vanuatuwok.vu/job-category/non-government-organisation-ngo/feed/ — GET 200 application/rss+xml; charset=UTF-8; 2 items
- https://vanuatuwok.vu/job-category/other/feed/ — GET 200 application/rss+xml; charset=UTF-8; 2 items
- https://vanuatuwok.vu/job-category/trades-services/feed/ — GET 200 application/rss+xml; charset=UTF-8; 1 items
- https://vanuatuwok.vu/job-category/transport-logistics/feed/ — GET 200 application/rss+xml; charset=UTF-8; 4 items
- https://vanuatuwok.vu/job-salary/0-100000/feed/ — GET 200 application/rss+xml; charset=UTF-8; 5 items
- https://vanuatuwok.vu/job-salary/4000000-or-more/feed/ — GET 200 application/rss+xml; charset=UTF-8; 1 items
- https://vanuatuwok.vu/job-salary/6000000-or-more/feed/ — GET 200 application/rss+xml; charset=UTF-8; 1 items
- https://vanuatuwok.vu/job-salary/according-to-experience-and-qualification/feed/ — GET 200 application/rss+xml; charset=UTF-8; 3 items
- https://vanuatuwok.vu/job-salary/not-stated/feed/ — GET 200 application/rss+xml; charset=UTF-8; 16 items
- https://vanuatuwok.vu/job-type/casual/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/job-type/contract/feed/ — GET 200 application/rss+xml; charset=UTF-8; 10 items
- https://vanuatuwok.vu/job-type/full-time/feed/ — GET 200 application/rss+xml; charset=UTF-8; 16 items
- https://vanuatuwok.vu/job-type/not-stated/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/job-type/part-time/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/job-type/voluntary/board-position/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/job-type/voluntary/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/job-type/voluntary/internship-voluntary/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/jobs/enumerator/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/jobs/feed/ — GET 200 application/rss+xml; charset=UTF-8; 20 items
- https://vanuatuwok.vu/organisation/83-islands-distillery/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/agence-universitaire-de-la-francophonie/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/ajc/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/bred-bank-(vanuatu)-limited/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/carpenter-motors-(vanuatu)-limited/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/entani-company/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/giz/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/hseq-vanuatu/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/iririki-island-resort-and-spa/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/law-partners/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/link-personnel-services/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/nasama-resort/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/nasituan/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/novo-dental/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/oxfam/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/pacific-energy/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/spycon-ltd/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/tamanu-on-the-beach/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/teouma-christian-academy/feed/ — GET 200 application/rss+xml; charset=UTF-8; 1 items
- https://vanuatuwok.vu/organisation/titan-fx/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/tower-insurance/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/unelco-engie/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/vanuatu-air-charters-ltd/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/vanuatu-brewing-ltd/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/vanuatu-helicopters/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/vanuatu-qualifications-authority/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/vate-electrics/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/wanfuteng-bank/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/organisation/world-car-rentals-vanuatu/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/resumes/feed/ — GET 200 application/rss+xml; 20 items; CV content not inspected
- https://vanuatuwok.vu/rss-feed/ — GET 200 text/xml; charset=UTF-8; 20 items
- https://vanuatuwok.vu/sample-page/feed/ — GET 200 application/rss+xml; charset=UTF-8; 0 items
- https://vanuatuwok.vu/volunteer-jobs/rss-feed/ — GET 200 text/xml; charset=UTF-8; 1 item

## 7. PDF files (6)

- https://vanuatuwok.vu/app/uploads/2021/05/A5-PRINT-VERSION-Vanuatu-Wok-booklet-PDF-version-1.pdf — HEAD 200 application/pdf; 844693 bytes
- https://vanuatuwok.vu/app/uploads/2020/09/Press-Release-Lands-Reforms-_compressed.pdf — HEAD 200 application/pdf; 1208460 bytes
- https://vanuatuwok.vu/app/uploads/2026/10/REOI-Change-Mangement-Specialist.pdf — HEAD 200 application/pdf; 256083 bytes
- https://vanuatuwok.vu/app/uploads/2026/11/Primary-Teachers-job-advertisement.pdf — HEAD 200 application/pdf; 125306 bytes
- https://vanuatuwok.vu/app/uploads/2026/11/REOI-ESMASP-Real-Estate-Agent-Readvertised.pdf — HEAD 200 application/pdf; 189614 bytes
- https://vanuatuwok.vu/app/uploads/2026/11/REOI-%E2%80%93-ESMASP-Conveyancing-Lawyer-Readvertised.pdf — HEAD 200 application/pdf; 183122 bytes

## 8. Shortlinks (`?p=`; 50; all 301 -> canonical, final 200)

- https://vanuatuwok.vu/?p=10 -> https://vanuatuwok.vu/terms-conditions/
- https://vanuatuwok.vu/?p=140040 -> https://vanuatuwok.vu/jobs/experienced-chef-bar-kitchen-reception-office/
- https://vanuatuwok.vu/?p=141332 -> https://vanuatuwok.vu/jobs/mason%ef%bc%88bricklayer-brickmason%ef%bc%89/
- https://vanuatuwok.vu/?p=141435 -> https://vanuatuwok.vu/jobs/experienced-resort-staff/
- https://vanuatuwok.vu/?p=141471 -> https://vanuatuwok.vu/jobs/vendeur-preparateur-livreur-6/
- https://vanuatuwok.vu/?p=141516 -> https://vanuatuwok.vu/jobs/logistics-assistant-2/
- https://vanuatuwok.vu/?p=141525 -> https://vanuatuwok.vu/jobs/trainee/
- https://vanuatuwok.vu/?p=141550 -> https://vanuatuwok.vu/jobs/skills-adviser-vanuatu-multiple-positions/
- https://vanuatuwok.vu/?p=141564 -> https://vanuatuwok.vu/jobs/provision-of-dwssp-training-and-reporting-for-tafea-province/
- https://vanuatuwok.vu/?p=141568 -> https://vanuatuwok.vu/jobs/provision-of-dwssp-training-and-reporting-for-sanma-province/
- https://vanuatuwok.vu/?p=141575 -> https://vanuatuwok.vu/jobs/senior-analyst-parts-supervisor-5/
- https://vanuatuwok.vu/?p=141584 -> https://vanuatuwok.vu/jobs/mechanic-10/
- https://vanuatuwok.vu/?p=141597 -> https://vanuatuwok.vu/jobs/provision-of-technical-assessment-design-and-cost-estimation-of-five-earthquake-affected-community-water-supply-systems-in-efate-vanuatu/
- https://vanuatuwok.vu/?p=141601 -> https://vanuatuwok.vu/jobs/labour-construction-works-only-for-three-3-rainwater-harvesting-systems-on-paama-island-at-the-following-sites-liro-tevali-tevaliaot/
- https://vanuatuwok.vu/?p=141609 -> https://vanuatuwok.vu/jobs/disaster-ready-project-manager-3/
- https://vanuatuwok.vu/?p=141615 -> https://vanuatuwok.vu/jobs/request-for-expressions-of-interest-reoi-change-management-specialist-pecialist/
- https://vanuatuwok.vu/?p=141635 -> https://vanuatuwok.vu/jobs/request-for-quotation-development-of-a-revised-vanuatu-national-ngo-policy-towards-a-strategic-partnership-framework-for-localised-development-2026-2020/
- https://vanuatuwok.vu/?p=141638 -> https://vanuatuwok.vu/jobs/housekeeping-supervisor-3/
- https://vanuatuwok.vu/?p=141639 -> https://vanuatuwok.vu/jobs/welder-2/
- https://vanuatuwok.vu/?p=141651 -> https://vanuatuwok.vu/jobs/administration-manager-4/
- https://vanuatuwok.vu/?p=141660 -> https://vanuatuwok.vu/jobs/senior-lecturer-in-accounting/
- https://vanuatuwok.vu/?p=141663 -> https://vanuatuwok.vu/jobs/lecturer-in-accounting/
- https://vanuatuwok.vu/?p=141675 -> https://vanuatuwok.vu/jobs/teachers-2/
- https://vanuatuwok.vu/?p=141683 -> https://vanuatuwok.vu/jobs/readvertised-request-for-expressions-of-interest-reoi-real-estate-agent-firm/
- https://vanuatuwok.vu/?p=141688 -> https://vanuatuwok.vu/jobs/readvertised-request-for-expressions-of-interest-reoi-esmasp-conveyancing-lawyer/
- https://vanuatuwok.vu/?p=141698 -> https://vanuatuwok.vu/jobs/request-for-quotation-expert-concultant-to-develop-an-important-substitution-srategy/
- https://vanuatuwok.vu/?p=141704 -> https://vanuatuwok.vu/jobs/executive-chef-16/
- https://vanuatuwok.vu/?p=141709 -> https://vanuatuwok.vu/jobs/enumerator/
- https://vanuatuwok.vu/?p=141716 -> https://vanuatuwok.vu/jobs/job-vacancy-junior-photocopier-technician/
- https://vanuatuwok.vu/?p=16 -> https://vanuatuwok.vu/login/
- https://vanuatuwok.vu/?p=<redacted> -> https://vanuatuwok.vu/resumes/<redacted>/
- https://vanuatuwok.vu/?p=168 -> https://vanuatuwok.vu/job-email-text/
- https://vanuatuwok.vu/?p=17 -> https://vanuatuwok.vu/register/
- https://vanuatuwok.vu/?p=18 -> https://vanuatuwok.vu/password-recovery/
- https://vanuatuwok.vu/?p=2 -> https://vanuatuwok.vu/sample-page/
- https://vanuatuwok.vu/?p=206 -> https://vanuatuwok.vu/sign-up/
- https://vanuatuwok.vu/?p=23445 -> https://vanuatuwok.vu/organisations/
- https://vanuatuwok.vu/?p=29143 -> https://vanuatuwok.vu/organisation-competition/
- https://vanuatuwok.vu/?p=29301 -> https://vanuatuwok.vu/contact-2/
- https://vanuatuwok.vu/?p=33579 -> https://vanuatuwok.vu/land-law-reforms/
- https://vanuatuwok.vu/?p=38 -> https://vanuatuwok.vu/employers/
- https://vanuatuwok.vu/?p=3983 -> https://vanuatuwok.vu/about-us/
- https://vanuatuwok.vu/?p=5 -> https://vanuatuwok.vu/blog/
- https://vanuatuwok.vu/?p=61 -> https://vanuatuwok.vu/volunteer-jobs/
- https://vanuatuwok.vu/?p=655 -> https://vanuatuwok.vu/contact/
- https://vanuatuwok.vu/?p=68 -> https://vanuatuwok.vu/confirm/
- https://vanuatuwok.vu/?p=70 -> https://vanuatuwok.vu/resend-confirmation/
- https://vanuatuwok.vu/?p=73891 -> https://vanuatuwok.vu/home-2/
- https://vanuatuwok.vu/?p=791 -> https://vanuatuwok.vu/no-resumes/
- https://vanuatuwok.vu/?p=9 -> https://vanuatuwok.vu/job-date-archive/

## 9. Interactions and filters exercised

- Home/jobs search: `GET /jobs/?s=chef` 200 (2 results), `?s=teacher` 200 (1), `?s=nurse` 200 (0), `?s=zzzznonexistentterm` 200 (0, no-results state).
- Location filter: `?location=Port+Vila` 200 (18), `?location=Efate` 200 (18); combined `?s=chef&location=Port+Vila` 200 (1).
- Job-type checkbox filter: `?full-time=show&action=Filter` 200 (16), `?contract=show&action=Filter` 200 (10).
- Job taxonomies (23) reachable and list matching jobs; job date archive `?time=today|week|lastweek|month` all 200 and each showed 3 jobs; base `/job-date-archive/` showed 0 without `jobs_by_date=1`.
- Pagination: `/jobs/` 20 jobs, `/jobs/page/2/` 8 jobs, `/jobs/page/1/` 301 to `/jobs/`, `/jobs/page/3/`, `/4/`, `/5/` 404.
- Organisation directory: `/organisations/` 200, 29 profiles. `?organisation_type=business|government|not_for_profit` and `?organisation_size=1-5` all returned 200 but the same 29 results; filters are JS-driven/AJAX or server-side ignored — no observable effect without a browser.
- Feeds: site/job/volunteer/taxonomy/organisation feeds all 200; `/resumes/feed/` 200 RSS (20 items, not inspected).
- Not exercised: any form submission (contact, apply, login, register, password reset, resend confirmation, job submission), AddThis share (third-party JS), print (client-side only).

## 10. Errors, duplicates, gaps, limitations

- **404:** `/login/&role=job_seeker` (malformed link from 404 pagination pages); two sitemap-published CV taxonomy URLs (HEAD and GET both returned 404).
- **405:** `/wp/xmlrpc.php` (HEAD/GET; POST-only endpoint), `/wp/xmlrpc.php?rsd` 200 text/xml.
- **500:** all 174 reachable resume taxonomy pages; sampled `/resumes/` and `/resumes/<redacted>/`. HEAD for the same routes is 200. This is the central HEAD/GET discrepancy.
- **Duplicates / near-duplicates:** `/jobs` and `/jobs/`; `about-us`/`about-us/`; `contact`/`contact/`; `login`/`login/`; `register`/`register/`; `sign-up`/`sign-up/`; `submit`/`submit/`; `my-profile`/`my-profile/`; `/employer/` 301 -> `/employers/`; `/wp/jobs/` 301 -> `/jobs/`; `/wp/rss-feed/` 301 -> `/rss-feed/`; `/wp/wp-login.php` 302 -> `/login/`; `mason（bricklayer-brickmason）` and its percent-encoded form both 200.
- **Sitemap gaps:** 28 live job-detail pages linked from organisation profiles are not in `job_listing-sitemap.xml`. Resume sitemap contains 2 URLs that 404.
- **Transient:** a burst of 161 Cloudflare 503/`retry-after: 3600` responses occurred under 6-way concurrency; all were retried sequentially and ended 200/500 as recorded. This is a crawl limitation, not necessarily site behavior for a normal user.
- **Not established:** traffic, real usage, authenticated employer/CV access, whether the 500 is intentional or a regression, and whether the CV RSS feed is intended to be public. No analytics were available.
- **Out of scope / not accessed:** `/wp-admin/` (discovered in a page link; admin surface), `cdn-cgi/l/email-protection` (Cloudflare email obfuscation), all form submissions and all CV/attachment bodies.

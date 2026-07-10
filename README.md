# OPDS Catalog

Serves your BackIssue library to native comic-reader apps — **Panels**,
**Chunky**, **KyBook**, and anything else that speaks OPDS. Browse series,
search, download issues (resumable), and stream page-by-page, all from a
phone or tablet.

## Install

One click from **Sidebar → Plugins** in BackIssue, or drop this folder into
the app's `plugins/` directory and restart.

## Setup

Point your reader app at:

```
http(s)://<your-backissue-host>/api/opds
```

and sign in with your BackIssue username + password (HTTP Basic). Your
personal catalog URL is also shown on your **Profile** page. Both OPDS 1.2
(`/api/opds`) and 2.0 (`/api/opds/v2`) are served; use 1.2 if unsure — page
streaming (PSE) is a 1.2 feature.

Access is a grantable permission (**OPDS catalog**), mature-flagged series
follow the same visibility rules as the web app, and with the
[Reader plugin](https://backissue.app/reading) installed the catalog adds
per-user **Continue reading** / **Read later** shelves and page streaming.

Full guide: <https://backissue.app/opds>

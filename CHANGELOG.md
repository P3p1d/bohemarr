# Changelog

## 2026-09-30

### Archive search and downloads

- Publish actual video resolution, audio language and media size in Newznab releases. Adaptive-stream sizes are explicitly marked as estimates.
- Select the highest available video rendition by resolution and bitrate, with Czech audio preferred, for both search metadata and downloads.
- Preserve movie production years from Prima+ and Česká televize metadata. Radarr title-and-year searches reject conflicting or unknown source years rather than relabelling a sequel.
- Renew a rejected Prima account session and retry the affected request once; unrelated failures are not retried as authentication failures.
- Resolve localized series names through verified external identities: Skyhook supplies the TVDB identity and linked TMDB TV ID; TVmaze local names and alternate names are accepted only after verifying the linked TVDB ID.
- Persist the nullable TMDB TV ID in `series_mappings`, migrating existing databases without reassigning stored bindings. Movie and TV TMDB IDs remain distinct namespaces.
- Limit Newznab pages to five results, retaining `offset` pagination, to bound live playback-metadata inspection for account-enabled catalogues.

### One-off deployment data operation

The catalogue matching pass is a completed deployment operation, **not a committed database dump or a new automatic synchronization feature**.

- Examined 21,015 category occurrences across the four enabled sources, corresponding to 16,967 unique `(provider, source_id)` catalogue entries.
- Stored 4,716 verified TMDB relations: 4,225 movie relations and 491 TV relations, representing 3,716 distinct TMDB movies and 467 distinct TMDB TV series.
- Recorded all entries, including unmatched entries and their reasons, in the production SQLite table `catalogue_tmdb_mappings`.

| Source | Verified TMDB relations | Without a verified relation |
| --- | ---: | ---: |
| Prima | 1,945 | 2,771 |
| Oneplay | 1,775 | 688 |
| Česká televize | 996 | 7,314 |
| Stream.cz | 0 | 1,478 |
| **Total** | **4,716** | **12,251** |

- Added 487 verified series bindings to the existing Sonarr matching table; four bindings already existed and no existing binding was reassigned.
- Accepted additional localized names from TMDB movie metadata and verified, typed TMDB TV pages. Names were not guessed or translated automatically.
- Left 12,251 entries without a verified relation: 5,660 lack a source production year; 4,950 have no exact title-and-year match; 1,491 fail the verified TV title/year/country criteria; 71 have ambiguous identities; 38 have conflicting source metadata; 21 have external metadata lookup/verification errors; and 20 lack a source country.
- Created a private pre-operation SQLite backup. Database snapshots, account credentials and temporary collectors are not committed to the repository.

### Verification and limitations

- Type checking and build passed for the archive-search changes; all 105 tests passed in Docker with the media tools available.
- Sonarr returned `Extractors S01E01 (CZ)[WEB-DL][1080p]` without rejection. A newly prefilled bilingual binding returned `The Affair S01E01 (CZ)[WEB-DL][1080p]` for the Czech programme *Aféra* through the actual Newznab service.
- Revalidated all 4,716 installed relations and checked SQLite integrity successfully.
- The account-enabled Sonarr connection test passed with five-result pages.
- This pass did **not** pair every catalogue entry. Missing or conflicting identity evidence remains unresolved rather than forced into a match.
- Movie relations are stored in SQL; the current Radarr search implementation does **not** consume that bulk-mapping table.

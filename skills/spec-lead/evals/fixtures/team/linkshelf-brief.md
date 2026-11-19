# Team brief: Linkshelf, a personal bookmark shelf

## Problem

The owner wants a small web app where a signed-in person saves links with a title, a note, and tags, finds them again by search or tag, and receives a weekly email digest of what they saved.
It is a new project.
There is one kind of user, and each user sees only their own links.

## Draft acceptance criteria

- AC-1 (draft): a visitor can sign up with email and password and is then signed in.
- AC-2 (draft): a signed-in user can save a link with a URL, a title, an optional note, and zero or more tags.
- AC-3 (draft): the link list shows the user's links newest first and can be filtered by one tag.
- AC-4 (draft): searching by a word returns the user's links whose title or note contains it.
- AC-5 (draft): a user never sees or changes another user's links.
- AC-6 (draft): once a week each user with new links receives one email listing them.
- AC-7 (draft): the list is usable at 1440x900 and at 390x844.

## Constraints

- TypeScript on Bun, one repository, one person operating it.
- Expected scale is tens of users and a few thousand links each.
- No native app, no browser extension, no sharing between users.

## What exists

New project; the repository holds only a README and an empty `AGENTS.md`.

## Questions for each specialist

- architect: one deployable or more, where the weekly digest runs, and how the app is structured so later tasks stay small.
- infra: where it is hosted, where data lives, how sign-in and email are provided, and what the owner must set up.
- frontend: the screens, how the list and the save form behave at both viewports, and which components and fonts to use.
- threat-modeler: what can go wrong with accounts, per-user data, saved URLs, and the digest email.

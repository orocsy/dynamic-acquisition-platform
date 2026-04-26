# Popup and Profile Policy

## Problem statement
Remote debugging consent popups and profile interference happen when automation attaches to the user's real Chrome or `profile=user` by default.

## Policy
### Default
- default automation target must be a dedicated daemon profile
- no default attach to live user Chrome

### Allowed exceptions
- explicit discovery mode
- manual auth bridge mode
- one-time import/bootstrap actions

### Forbidden by default
- routine production automation on the user’s daily browsing profile
- multi-instance profile confusion caused by automation taking over the user browser

## Desired UX outcome
- no routine consent popups
- no need for the user to click approval popups during normal runs
- no accidental locking of the user's own daily tabs/profile flow

## Technical implication
All old code paths that assume `profile=user` as the normal route must be downgraded or removed.

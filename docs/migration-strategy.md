# Migration Strategy

## Rule
Do not break currently working flows just to chase architectural purity.

## Principle
- existing working flows remain in place
- new shared platform is built and tested separately
- migration happens flow by flow
- each migration must prove equal or better stability

## Migration path

### Step 1
Build the new repo and core modules.

### Step 2
Prototype stable daemon and browser bridge there.

### Step 3
Use production workflow browser hunt as the first real migrated workflow.

### Step 4
If daemon-first test passes, replace default browser entrypoint in production workflow.

### Step 5
Push the phase to GitHub.

### Step 6
Migrate one content acquisition workflow.

## Anti-patterns to avoid
- forcing all current scripts into the new repo too early
- deleting old working code before parity exists
- adopting all of OpenCLI before understanding the source and fit
- building a giant generic engine without first validating module boundaries on real tasks

## Success criteria
A migration phase is good if:
- it removes one class of repeated problems
- it reduces coupling
- it improves stability or observability
- it does not erase current working production value

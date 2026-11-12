# Branching strategy

main is release ready and protected. Nobody pushes to it directly.

Two integration branches sit under main:

- features-enhancements takes every feature and enhancement.
- bugs-defects takes every issue, bug fix and defect.

Short lived work branches use the house style:

- feature/<name> for features, merged by PR into features-enhancements.
- fix/<issue> for fixes, merged by PR into bugs-defects.
- docs/<topic> for docs, merged by PR into features-enhancements.

Flow: feature/x is cut from features-enhancements and PR merged back
into it, then features-enhancements is PR merged into main when a
batch is done and green. Same shape on the bugs side with
bugs-defects.

Rules:

- main blocks force push and deletion, and requires linear history.
- Every merge into main comes through a PR, by convention until a
  second reviewer joins and an approval gate is switched on.
- Status checks will be required on main once CI lands.
- Push notes use plain lines with no bullets or markdown, paste
  friendly.

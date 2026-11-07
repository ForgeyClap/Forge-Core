# Codebase design vocabulary for reviews

Read this when a review touches a module's interface, where a seam sits, or whether an abstraction earns its
place. It gives shared words so a finding says the same thing every time. It sharpens the simplicity and
maintainability steps of the fixed review order; it never outranks a bug or a security issue.

## Terms (use them exactly)
- **Module**: anything with an interface and an implementation, at any scale (function, class, package).
- **Interface**: everything a caller must know: types, but also invariants, ordering, error modes, required
  configuration and performance traits. It is wider than a signature.
- **Depth**: how much behaviour a caller can use per unit of interface learned. Deep = small interface, a lot
  behind it. Shallow = interface nearly as complex as the body.
- **Seam**: a place where behaviour can change without editing that place; the location of an interface.
- **Adapter**: a concrete thing that fills a seam. Judge it by its role, not its size.
- **Leverage** (what callers gain from depth) and **locality** (change, bugs and checks concentrate in one
  place).
Avoid "boundary", "component", "service" and "API" for these ideas; they mean other things elsewhere.

## Review questions
- **Deletion test.** If this module vanished, would the complexity vanish (a pass-through, flag it as
  unneeded) or reappear in many callers (it earns its keep)?
- **Test surface.** Do tests cross the same interface callers use? A test that must reach past the interface
  suggests the module has the wrong shape.
- **One adapter is a hypothetical seam; two is a real one.** A seam with a single implementation and no
  second use is speculative indirection. This is the design-level twin of ponytail's yagni finding.
- **Dependencies passed in, results returned.** Code that builds its own collaborators or mutates its inputs
  is hard to test; say which and point to the line.
- **Surface size.** Can methods or parameters be cut, or more complexity hidden inside?

## How to report
A design finding gives the module, the term that applies, a concrete case (callers counted by grep), and the
smaller interface you would expect. Without a case it is an opinion, not a finding. Rewriting a design is a
separate task; a review names the problem and the direction.

## Provenance
Rewritten in Forge words; pattern adapted and no code taken. The term definitions under "Terms" follow the
source's own definitions closely (short technical definitions, MIT), on purpose, so the vocabulary matches it. Source, read read-only through
`gh api` on 2026-11-06 and treated as untrusted data (taken from the original repository, not from an
aggregator copy): `mattpocock/skills`, `skills/engineering/codebase-design/SKILL.md`, last commit for the path
`321658273cb1`, license MIT. Found through the corpus index. The seam idea is credited to Michael Feathers in
the source. Left out: the diagrams, the code samples, the rejected-framings section, and the two linked
deep-dive files (not read).

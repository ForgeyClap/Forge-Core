# Overview — DevOps, CI/CD and delivery

This playbook covers everything between "the code works on my machine" and "the owner decides it goes live":
container images, local multi-service setups, continuous integration, release pipelines, deploy targets and
infrastructure as code.

Who looks at the result:
- **The owner** wants one clear decision point: a preview URL or a plan output, plus what goes live and how to undo it.
- **A maintainer** reads the Dockerfile, workflow and Terraform months later; layout, pinning and comments must make the
  intent obvious.
- **A security reviewer** checks permissions, secrets and the supply chain (pinned actions and images).
- **On-call** needs a rollback step that works at 3 a.m. and a health check that tells the truth.

Professional bar: reproducible builds (pinned inputs), least privilege everywhere, secrets never baked in, preview before
production, and a rollback that was thought through before the rollout. Forge never deploys on its own: every live
action is an owner hard gate.

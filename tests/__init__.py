"""Imported by unittest before any test module.

In GitHub Actions the job summary is a real file ($GITHUB_STEP_SUMMARY). collector.runner.summary() appends
to it, so tests that run the collector would put their fake run lines above the real result in the Collect
workflow. Tests never write to the job summary.
"""
import os

os.environ.pop("GITHUB_STEP_SUMMARY", None)

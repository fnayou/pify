"""Brand output must retain provenance after SVG regeneration."""

import shutil
import tempfile
import unittest
from pathlib import Path

from scripts.brand_generate import check, render_all


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class BrandDriftTest(unittest.TestCase):
    def test_source_change_requires_svg_and_png_regeneration(self):
        with tempfile.TemporaryDirectory(prefix="pify-brand-test-") as temporary:
            root = Path(temporary)
            shutil.copytree(PROJECT_ROOT / "brand", root / "brand")
            self.assertEqual(check(root), [])

            source = root / "brand" / "src" / "social-preview.svg"
            source.write_text(source.read_text().replace("{{TAGLINE}}", "{{TAGLINE}} "), encoding="utf-8")
            problems = check(root)
            self.assertIn("stale generated/social-preview.svg", problems)
            self.assertIn("generated/social-preview.png: stale or missing PNG source marker", problems)

            rendered = render_all(root)
            (root / "brand" / "generated" / "social-preview.svg").write_text(rendered["social-preview.svg"], encoding="utf-8")
            self.assertEqual(check(root), ["generated/social-preview.png: stale or missing PNG source marker"])


if __name__ == "__main__":
    unittest.main()

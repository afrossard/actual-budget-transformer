#!/usr/bin/env python3
"""Spike script to assess pyiso20022 for CAMT.053 parsing and generation.

Run with:
    uv run python scripts/spike_pyiso20022.py
"""

import glob
import sys
from pathlib import Path
from xsdata.formats.dataclass.parsers import XmlParser
from xsdata.formats.dataclass.serializers import XmlSerializer
from xsdata.formats.dataclass.serializers.config import SerializerConfig
from pyiso20022.camt.camt_053_001_08.camt_053_001_08 import Document

TESTS_DATA = Path(__file__).parent.parent / "tests" / "data"
SECTION = "-" * 60


def assess_parsing():
    print(SECTION)
    print("1. PARSING")
    print(SECTION)

    parser = XmlParser()
    xml_files = sorted(glob.glob(str(TESTS_DATA / "*.xml")))

    if not xml_files:
        print("ERROR: no XML fixtures found in tests/data/")
        return []

    results = []
    errors = []

    for path in xml_files:
        try:
            doc = parser.parse(path, Document)
            stmt = doc.bk_to_cstmr_stmt.stmt[0]
            iban = stmt.acct.id.iban
            entries = stmt.ntry
            entry_count = len(entries)

            parsed = []
            for ntry in entries:
                amount = float(ntry.amt.value)
                direction = ntry.cdt_dbt_ind.value  # 'CRDT' or 'DBIT'
                date = ntry.bookg_dt.dt
                addtl = ntry.addtl_ntry_inf or ""

                # Counterparty name
                payee = ""
                tx_dtls = ntry.ntry_dtls[0].tx_dtls[0] if ntry.ntry_dtls else None
                if tx_dtls and tx_dtls.rltd_pties:
                    cdtr = tx_dtls.rltd_pties.cdtr
                    dbtr = tx_dtls.rltd_pties.dbtr
                    if cdtr and cdtr.pty and cdtr.pty.nm:
                        payee = cdtr.pty.nm
                    elif dbtr and dbtr.pty and dbtr.pty.nm:
                        payee = dbtr.pty.nm

                parsed.append({
                    "date": date,
                    "amount": amount,
                    "direction": direction,
                    "payee": payee,
                    "notes": addtl,
                })

            results.append((path, iban, parsed))
            print(f"  OK  {Path(path).name}")
            print(f"       IBAN: {iban}  entries: {entry_count}")
            for e in parsed:
                sign = "-" if e["direction"] == "DBIT" else "+"
                print(f"       {e['date']}  {sign}{e['amount']:.2f}  payee={e['payee']!r}  notes={e['notes'][:40]!r}")

        except Exception as exc:
            errors.append((path, exc))
            print(f"  ERR {Path(path).name}: {exc}")

    print(f"\nParsed {len(results)}/{len(xml_files)} files successfully, {len(errors)} errors.")
    return results


def assess_generation(parsed_results):
    print()
    print(SECTION)
    print("2. GENERATION (round-trip)")
    print(SECTION)

    if not parsed_results:
        print("Skipping — no parsed results available.")
        return

    # Take the first parsed file as source
    source_path, iban, entries = parsed_results[0]

    parser = XmlParser()
    original_doc = parser.parse(source_path, Document)

    # Serialise back to XML
    config = SerializerConfig(pretty_print=True)
    serializer = XmlSerializer(config=config)
    xml_out = serializer.render(original_doc)

    # Re-parse the serialised output
    try:
        import io
        from xsdata.formats.dataclass.parsers.config import ParserConfig
        roundtrip_doc = parser.from_string(xml_out, Document)
        stmt = roundtrip_doc.bk_to_cstmr_stmt.stmt[0]
        rt_iban = stmt.acct.id.iban
        rt_entries = len(stmt.ntry)
        original_entries = len(original_doc.bk_to_cstmr_stmt.stmt[0].ntry)
        ok = rt_iban == iban and rt_entries == original_entries
        print(f"  Round-trip {'OK' if ok else 'MISMATCH'}: IBAN {rt_iban!r} (expected {iban!r}), entries {rt_entries} (expected {original_entries})")
    except Exception as exc:
        print(f"  Round-trip FAILED: {exc}")


def assess_version_tolerance():
    print()
    print(SECTION)
    print("3. VERSION TOLERANCE")
    print(SECTION)

    # Check which versions are available
    import pyiso20022.camt as camt_pkg
    import importlib
    available = []
    for v in range(1, 13):
        mod_name = f"pyiso20022.camt.camt_053_001_{v:02d}.camt_053_001_{v:02d}"
        try:
            importlib.import_module(mod_name)
            available.append(f"camt.053.001.{v:02d}")
        except ImportError:
            pass

    print(f"  Available camt.053 versions: {', '.join(available)}")
    print(f"  Our test files use: camt.053.001.08")
    print(f"  Covered: {'YES' if 'camt.053.001.08' in available else 'NO'}")


def main():
    print("pyiso20022 spike assessment")
    print(f"Library version: ", end="")
    try:
        from importlib.metadata import version
        print(version("pyiso20022"))
    except Exception:
        print("unknown")

    parsed = assess_parsing()
    assess_generation(parsed)
    assess_version_tolerance()

    print()
    print(SECTION)
    print("SUMMARY")
    print(SECTION)
    xml_files = glob.glob(str(TESTS_DATA / "*.xml"))
    print(f"  Files parsed:    {len(parsed)}/{len(xml_files)}")
    print(f"  Generation:      see round-trip result above")
    print(f"  API ergonomics:  typed dataclasses via xsdata")
    print(f"  New deps:        pyiso20022, xsdata (xsdata is installed as transitive dep)")


if __name__ == "__main__":
    main()

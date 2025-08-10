# Notes on processing Cembra Money Bank credit card scanned statements

## PDF OCR

`brew install ocrmypdf tesseract-lang poppler`

Note that debian bookworm has outdated versions of the above. Consider Alpine if automating further.

```
ocrmypdf \
 -l fra \
 --deskew \
 --clean \
 --output-type pdfa \
 --fast-web-view 0 \
 tmp/input_files/scan_20250805130537.pdf \
 tmp/output_files/ocr2.pdf \
&& \
pdftotext \
 -layout \
 tmp/output_files/ocr2.pdf \
 tmp/output_files/ocr2.txt
```

## LLM Prompt

Used succesfully with a remote Mistral-Small-3.2-24B-Instruct-2506.

```
You are a thorough and precise accountant. Below is extracted text from a scanned credit card statement read using ocrmypdf and then converted to text using poppler pdftotest -layout. The original document is in French.

You will find and extract transactions from the the text and present them in csv format with the following headers
transaction_date,payee,notes,debit,credit

Dates must be converted to yyyy-mm-dd.
Amounts must be converted to use a dot as decimal.
If the the payee or notes field end up containing the separator symbol, properly encapsulate the field in quotes.

There are 3 sections containing transaction details. Discard other information. Here are information on the three sections, how to recognise them and what to extract.

Generally, each section will be a table that may contain the following column headers
- transaction date ("Date de trans.")
- accounting date ("Date de com.")
- description ("Description")
- credit amount ("Crédit" followed by a currency code)
- debit amount ("Débit" followed by a currency code)
The amounts should be extracted based on the presence of "Crédit" or "Débit" in the column headers, and the currency code should be ignored.


The first section contains the oustanding amount from the previous invoice and mentions how much was paid and when. The columns include the accounting date, description and amounts (both credit and debit). Only extract the transaction reprensting our payment, ignore the previous invoice amount. In this case the payee is "ourselves" and the description must be copied to the "notes" column.

The second section contains details of all debits and credits made with the credit card and may span mulitple pages. It generally starts with a one-liner identfying the card being used. The columns include the transaction date, the accounting date, a description that may span mulitple lines, and amounts (both credit and debit). The description's first line is the payee, the other lines, if any, must be copied to the "notes" column. The amounts in this section are mostly debits.

The third section contains details about fees and penalties. It generally starts with a title "Divers". The columns include the accounting date, a description, and amounts (both credit and debit). The payee is considered to be "Cembra" and the description must be copied to the "notes" column.

Extracted text:

```

include extracted txt

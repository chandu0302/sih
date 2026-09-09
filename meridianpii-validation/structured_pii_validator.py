import re
import json


# =========================================================
# Aadhaar Verhoeff checksum validation
# =========================================================

D_TABLE = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
]

P_TABLE = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 5, 2, 8, 3]
]


def verhoeff_checksum(number):

    digits = [int(d) for d in number]

    checksum = 0

    for i, digit in enumerate(reversed(digits)):
        checksum = D_TABLE[checksum][
            P_TABLE[(i + 1) % 8][digit]
        ]

    return checksum == 0


def valid_aadhaar(value):

    digits = re.sub(r"\s+", "", value)

    if not re.fullmatch(r"\d{12}", digits):
        return False

    # Aadhaar numbers should not start with 0 or 1
    if digits[0] in "01":
        return False

    return verhoeff_checksum(digits)


# =========================================================
# Structured PII patterns
# =========================================================

PATTERNS = {

    "AADHAAR": re.compile(
        r"(?<!\d)(?:\d{4}\s?\d{4}\s?\d{4})(?!\d)"
    ),

    "PAN": re.compile(
        r"\b[A-Z]{5}[0-9]{4}[A-Z]\b",
        re.IGNORECASE
    ),

    "PHONE": re.compile(
        r"(?<!\d)(?:\+91[\s-]?)?[6-9]\d{9}(?!\d)"
    ),

    "EMAIL": re.compile(
        r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"
    ),

    "URL": re.compile(
        r"https?://[^\s]+",
        re.IGNORECASE
    ),

    "IFSC": re.compile(
        r"\b[A-Z]{4}0[A-Z0-9]{6}\b",
        re.IGNORECASE
    ),

    "GSTIN": re.compile(
        r"\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[A-Z0-9]\b",
        re.IGNORECASE
    )
}


# =========================================================
# Detection function
# =========================================================

def detect_pii(text, pii_type):

    pattern = PATTERNS[pii_type]

    matches = pattern.findall(text)

    if pii_type == "AADHAAR":

        valid_matches = []

        for match in matches:

            if valid_aadhaar(match):
                valid_matches.append(match)

        return valid_matches

    return matches


# =========================================================
# Comprehensive test dataset
# =========================================================

test_cases = [

    # -----------------------------------------------------
    # AADHAAR - POSITIVE
    # -----------------------------------------------------

   {
    "id": "AAD-P01",
    "type": "AADHAAR",
    "category": "positive",
    "text": "Aadhaar number: 3456 7890 1236.",
    "expected": True
},
{
    "id": "AAD-P02",
    "type": "AADHAAR",
    "category": "positive",
    "text": "My Aadhaar is 345678901236.",
    "expected": True
},

    # -----------------------------------------------------
    # AADHAAR - NEGATIVE / EDGE
    # -----------------------------------------------------

    {
        "id": "AAD-N01",
        "type": "AADHAAR",
        "category": "negative",
        "text": "Reference number is 12345.",
        "expected": False
    },

    {
        "id": "AAD-E01",
        "type": "AADHAAR",
        "category": "edge",
        "text": "Aadhaar: 3111-1111-1116.",
        "expected": False
    },

    {
        "id": "AAD-E02",
        "type": "AADHAAR",
        "category": "edge",
        "text": "Possible Aadhaar: 3111 1111 1117.",
        "expected": False
    },


    # -----------------------------------------------------
    # PAN - POSITIVE
    # -----------------------------------------------------

    {
        "id": "PAN-P01",
        "type": "PAN",
        "category": "positive",
        "text": "PAN number is ABCDE1234F.",
        "expected": True
    },

    {
        "id": "PAN-P02",
        "type": "PAN",
        "category": "positive",
        "text": "PAN: PQRSX5678K.",
        "expected": True
    },

    # PAN - negative / edge

    {
        "id": "PAN-N01",
        "type": "PAN",
        "category": "negative",
        "text": "Today is a sunny day.",
        "expected": False
    },

    {
        "id": "PAN-E01",
        "type": "PAN",
        "category": "edge",
        "text": "PAN: ABCD1234F.",
        "expected": False
    },

    {
        "id": "PAN-E02",
        "type": "PAN",
        "category": "edge",
        "text": "Code ABCDE12345 is not a PAN.",
        "expected": False
    },


    # -----------------------------------------------------
    # PHONE - POSITIVE
    # -----------------------------------------------------

    {
        "id": "PH-P01",
        "type": "PHONE",
        "category": "positive",
        "text": "Call me at 9876543210.",
        "expected": True
    },

    {
        "id": "PH-P02",
        "type": "PHONE",
        "category": "positive",
        "text": "My number is +91 9123456789.",
        "expected": True
    },

    {
        "id": "PH-P03",
        "type": "PHONE",
        "category": "positive",
        "text": "Contact: +91-9876543210.",
        "expected": True
    },

    # PHONE negative / edge

    {
        "id": "PH-N01",
        "type": "PHONE",
        "category": "negative",
        "text": "Room number 123456.",
        "expected": False
    },

    {
        "id": "PH-E01",
        "type": "PHONE",
        "category": "edge",
        "text": "Number: 1234567890.",
        "expected": False
    },


    # -----------------------------------------------------
    # EMAIL - POSITIVE
    # -----------------------------------------------------

    {
        "id": "EM-P01",
        "type": "EMAIL",
        "category": "positive",
        "text": "Email me at rahul@example.com.",
        "expected": True
    },

    {
        "id": "EM-P02",
        "type": "EMAIL",
        "category": "positive",
        "text": "Contact priya.reddy123@gmail.com.",
        "expected": True
    },

    {
        "id": "EM-P03",
        "type": "EMAIL",
        "category": "positive",
        "text": "Support email: user.name+test@company.co.in.",
        "expected": True
    },

    # EMAIL negative / edge

    {
        "id": "EM-N01",
        "type": "EMAIL",
        "category": "negative",
        "text": "Please send the document tomorrow.",
        "expected": False
    },

    {
        "id": "EM-E01",
        "type": "EMAIL",
        "category": "edge",
        "text": "Email: user@example",
        "expected": False
    },


    # -----------------------------------------------------
    # URL - POSITIVE
    # -----------------------------------------------------

    {
        "id": "URL-P01",
        "type": "URL",
        "category": "positive",
        "text": "Visit https://example.com.",
        "expected": True
    },

    {
        "id": "URL-P02",
        "type": "URL",
        "category": "positive",
        "text": "Website: http://example.org/page.",
        "expected": True
    },

    # URL negative

    {
        "id": "URL-N01",
        "type": "URL",
        "category": "negative",
        "text": "The website is unavailable.",
        "expected": False
    },


    # -----------------------------------------------------
    # IFSC - POSITIVE
    # -----------------------------------------------------

    {
        "id": "IFSC-P01",
        "type": "IFSC",
        "category": "positive",
        "text": "IFSC code: SBIN0001234.",
        "expected": True
    },

    {
        "id": "IFSC-P02",
        "type": "IFSC",
        "category": "positive",
        "text": "Bank IFSC is HDFC0005678.",
        "expected": True
    },

    # IFSC negative / edge

    {
        "id": "IFSC-N01",
        "type": "IFSC",
        "category": "negative",
        "text": "The bank opens at 10 AM.",
        "expected": False
    },

    {
        "id": "IFSC-E01",
        "type": "IFSC",
        "category": "edge",
        "text": "IFSC: SBI0001234.",
        "expected": False
    },


    # -----------------------------------------------------
    # GSTIN - POSITIVE
    # -----------------------------------------------------

    {
        "id": "GST-P01",
        "type": "GSTIN",
        "category": "positive",
        "text": "GSTIN: 29ABCDE1234F1Z5.",
        "expected": True
    },

    {
        "id": "GST-P02",
        "type": "GSTIN",
        "category": "positive",
        "text": "GST number: 27AAAPA1234A1Z5.",
        "expected": True
    },

    # GSTIN negative

    {
        "id": "GST-N01",
        "type": "GSTIN",
        "category": "negative",
        "text": "The company has many customers.",
        "expected": False
    },


    # -----------------------------------------------------
    # MULTI-PII
    # -----------------------------------------------------

    {
        "id": "MULTI-01",
        "type": "EMAIL",
        "category": "multi_pii",
        "text": "Rahul can be contacted at rahul@example.com.",
        "expected": True
    },

    {
        "id": "MULTI-02",
        "type": "PHONE",
        "category": "multi_pii",
        "text": "Call Priya at 9876543210 or email priya@example.com.",
        "expected": True
    },

    {
        "id": "MULTI-03",
        "type": "PAN",
        "category": "multi_pii",
        "text": "PAN ABCDE1234F and GSTIN 29ABCDE1234F1Z5 are recorded.",
        "expected": True
    }
]


# =========================================================
# Run tests
# =========================================================

TP = 0
FP = 0
FN = 0
TN = 0

results = []


for test in test_cases:

    matches = detect_pii(
        test["text"],
        test["type"]
    )

    detected = len(matches) > 0
    expected = test["expected"]

    if expected and detected:
        result = "TP"
        TP += 1

    elif not expected and not detected:
        result = "TN"
        TN += 1

    elif not expected and detected:
        result = "FP"
        FP += 1

    else:
        result = "FN"
        FN += 1


    print("=" * 70)
    print(f"Test ID   : {test['id']}")
    print(f"Type      : {test['type']}")
    print(f"Category  : {test['category']}")
    print(f"Input     : {test['text']}")
    print(f"Expected  : {expected}")
    print(f"Detected  : {detected}")
    print(f"Matches   : {matches}")
    print(f"Result    : {result}")


# =========================================================
# Metrics
# =========================================================

precision = TP / (TP + FP) if TP + FP else 0
recall = TP / (TP + FN) if TP + FN else 0

f1 = (
    2 * precision * recall / (precision + recall)
    if precision + recall
    else 0
)


print("\n")
print("=" * 70)
print("STRUCTURED PII VALIDATION SUMMARY")
print("=" * 70)

print(f"TP        : {TP}")
print(f"FP        : {FP}")
print(f"FN        : {FN}")
print(f"TN        : {TN}")

print(f"\nPrecision : {precision:.4f} ({precision * 100:.2f}%)")
print(f"Recall    : {recall:.4f} ({recall * 100:.2f}%)")
print(f"F1 Score  : {f1:.4f} ({f1 * 100:.2f}%)")


# =========================================================
# Save results
# =========================================================

summary = {
    "true_positive": TP,
    "false_positive": FP,
    "false_negative": FN,
    "true_negative": TN,
    "precision": precision,
    "recall": recall,
    "f1": f1
}

with open(
    "structured_pii_results.json",
    "w",
    encoding="utf-8"
) as f:

    json.dump(summary, f, indent=4)


print("\nSaved: structured_pii_results.json")
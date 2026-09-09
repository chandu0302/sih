# Task 1 — MeridianPII Detection Validation

## 1. Objective

The objective of this task is to validate the MeridianPII Hindi PII detection model using a comprehensive test dataset containing:

- Positive PII cases
- Negative cases
- Edge cases
- Multi-PII cases
- Structured PII cases

The validation focuses on:

1. PII detection performance
2. Precision, Recall and F1-score
3. False positives and false negatives
4. Confidence threshold validation
5. Structured PII recognition
6. Recommendation for the NER confidence threshold

---

## 2. Model

**Model:** `plingampally/meridianpii-hi-v2`

The model is a token-classification NER model designed for:

- Hindi (Devanagari)
- Hinglish
- Indian English

The model supports PII entities such as:

- GIVEN_NAME
- SURNAME
- EMAIL
- PHONE
- URL
- BANK_ACCOUNT
- PASSPORT
- GOVERNMENT_ID
- BUILDING_NUMBER
- STREET_NAME
- CITY
- STATE
- ZIP_CODE

---

## 3. Test Dataset

The complete test dataset is stored in:

```text
test_cases.json
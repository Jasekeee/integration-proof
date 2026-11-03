// The only card the headless buyer uses: a Visa number published by PayPal for sandbox testing,
// https://developer.paypal.com/tools/sandbox/card-testing/
export const SANDBOX_TEST_CARD = {
  number: "4012888888881881",
  expiry: `${new Date().getUTCFullYear() + 3}-12`,
  security_code: "123",
  name: "Integration Proof",
  billing_address: {
    address_line_1: "2211 North First Street",
    admin_area_2: "San Jose",
    admin_area_1: "CA",
    postal_code: "95131",
    country_code: "US",
  },
};

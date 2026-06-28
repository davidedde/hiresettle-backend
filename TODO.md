# TODO

- [x] Add StellarService helpers: accountExists(), parse/stroops token balance for native vs token, and optional validation methods.

- [ ] Update StellarService.getBalance trustline/native handling + token param meaning.

- [ ] Update AuthService.register to use SKIP_ACCOUNT_VALIDATION=true behavior via StellarService.accountExists().
- [ ] Update EngagementsService.create to validate company token balance covers total escrow (already checks token balance) and add Stellar account existence checks at interaction point.
- [ ] Update StellarController GET /stellar/balance/:address?token= to default token to native and return clear errors.
- [ ] Validate build/tests.

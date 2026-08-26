import { PixelsmithError } from '@pixelsmith/contracts'

export { PixelsmithError } from '@pixelsmith/contracts'

export const MIN_PASSWORD_LENGTH = 12

export class WeakPasswordError extends PixelsmithError {
  constructor(reason: string) {
    super('weak_password', 400, `Password rejected: ${reason}`)
  }
}

export class AuthenticationError extends PixelsmithError {
  constructor(message = 'Email or password is incorrect') {
    // Deliberately vague: distinguishing "no such user" from "wrong password"
    // hands an attacker a user-enumeration oracle.
    super('authentication_failed', 401, message)
  }
}

export class AccountLockedError extends PixelsmithError {
  constructor(readonly until: number) {
    super('account_locked', 423, `Too many failed attempts. Try again after ${new Date(until).toISOString()}`)
  }
}

export class AccountDisabledError extends PixelsmithError {
  constructor() {
    super('account_disabled', 403, 'This account has been disabled')
  }
}

export class DuplicateEmailError extends PixelsmithError {
  constructor(email: string) {
    super('duplicate_email', 409, `An account already exists for ${email}`)
  }
}

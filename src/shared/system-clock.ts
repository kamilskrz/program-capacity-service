import { Injectable } from '@nestjs/common';

import { type Clock } from '../capacity/application/ports/clock';

/** The real wall clock, injected wherever `Clock` is asked for outside a test. */
@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Layma } from './layma';

describe('Layma', () => {
  let component: Layma;
  let fixture: ComponentFixture<Layma>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Layma]
    })
    .compileComponents();

    fixture = TestBed.createComponent(Layma);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
